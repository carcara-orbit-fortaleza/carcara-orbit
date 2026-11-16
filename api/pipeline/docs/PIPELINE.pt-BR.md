[English](PIPELINE.md) · **Português**

# Pipeline de harmonização

Este documento descreve o pipeline de dados implementado em `src/pipeline/`.

## 1. Entradas

O pipeline aceita arquivos CSV do FIRMS Active Fire. Ele detecta o sensor pelo
cabeçalho:

- MODIS: `brightness`, `confidence` numérica, plataformas Terra/Aqua;
- VIIRS: `bright_ti4`/`bright_ti5`, confiança `low|nominal|high`, plataformas
  SNPP/NOAA-20/NOAA-21.

As colunas suportadas incluem:

```text
latitude, longitude, brightness|bright_ti4, scan, track, acq_date, acq_time,
satellite, instrument, confidence, version, bright_t31|bright_ti5, frp,
daynight, type
```

O nome do arquivo também pode identificar o sensor (`modis`, `viirs`,
`noaa20`, `noaa21`). Metadados explícitos de fonte de `config/sources.json` são
usados para o NRT.

## 2. Normalização

Cada linha se torna:

```json
{
  "id": "MODIS-…",
  "lat": -17.8,
  "lon": -57.0,
  "date": "2020-09-15",
  "ts_utc": "2020-09-15T13:30:00.000Z",
  "ts_ms": 1600176600000,
  "year": 2020,
  "month": 9,
  "region_id": "pantanal",
  "biome": "Área úmida",
  "sensor": "MODIS",
  "platform": "Terra",
  "instrument": "MODIS C6.1",
  "resolution_m": 1000,
  "confidence": 85,
  "confidence_class": "alta",
  "brightness_k": 330.4,
  "frp_mw": 9.0,
  "daynight": "D",
  "qa_flag": "ok",
  "source": "MODIS_SP",
  "method_version": "h1.0"
}
```

Normalização de confiança:

| Sensor | Entrada | Score | Classe |
|---|---|---:|---|
| MODIS | 0–100 | valor | `<30` baixa, `30–79` nominal, `≥80` alta |
| VIIRS | `low` | 20 | `baixa` |
| VIIRS | `nominal` | 60 | `nominal` |
| VIIRS | `high` | 90 | `alta` |

Filtros:

- Linhas MODIS abaixo de `MODIS_MIN_CONFIDENCE` (padrão 30) são descartadas.
- Linhas VIIRS abaixo de `VIIRS_MIN_CLASS` (padrão `nominal`) são descartadas.
- Linhas fora dos polígonos das regiões configuradas são descartadas quando regiões
  são fornecidas.
- Coordenadas/datas/horários inválidos são descartados.

O FIRMS Active Fire CSV não contém máscara de nuvem. O `qa_flag` é derivado do
campo `type` (`0` → `ok`, `1` → `volcano`, `2` → `other`, `3` → `offshore`).
Filtragem de nuvem/borda exige um produto diferente e não está implementada aqui.

## 3. Agrupamento espaço-temporal

O mesmo incêndio pode ser detectado pelo Terra/Aqua ou por múltiplas plataformas
VIIRS. Os clusters unem detecções quando:

- a distância ≤ **1 km** (haversine);
- o tempo desde a primeira detecção do cluster ≤ **3 h** (duração do cluster).

O centroide do cluster é a média corrente de seus focos. Um cluster expõe:

- `sensors`: sensores únicos no cluster (`MODIS`, `VIIRS` ou ambos);
- `platforms`: plataformas únicas;
- `hotspot_count`;
- um foco representativo com a maior confiança.

O agrupamento usa um hash espacial de 0,01° e uma busca nas 3×3 células vizinhas.

## 4. Grid

Os clusters são atribuídos a células de 0,1°:

```text
cell_id = round(lon / 0.1) + "_" + round(lat / 0.1)
```

A unidade de contagem é o **cluster**, não o pixel.

## 5. Calibração

Janela: `CALIBRATION_START_YEAR`–`CALIBRATION_END_YEAR` (padrão 2012–2025).
A calibração usa clusters diurnos quando há dados suficientes; caso contrário,
recorre a todos os clusters.

Para cada região e mês:

```text
ratio[cell] = N_VIIRS[cell, month] / N_MODIS[cell, month]
raw_factor  = median(ratio[cell])
```

Apenas células com ambas as contagens > 0 são usadas. O fator é encolhido em direção
ao fator da região quando o número de células é pequeno:

```text
w = n_cells / (n_cells + k)          # k = CALIBRATION_SHRINKAGE_K (default 20)
factor = w * raw_factor + (1 - w) * region_factor
factor = clamp(factor, 0.5, 4.0)
```

A incerteza é estimada com um bootstrap determinístico da mediana (200 reamostragens;
intervalo de 95%). Confiança:

- `alta`: pelo menos `CALIBRATION_MIN_CELLS` e incerteza ≤ 20%;
- `média`: pelo menos `CALIBRATION_MIN_CELLS`;
- `baixa`: poucas células ou nenhuma sobreposição.

Se não houver sobreposição alguma, o fator volta para `1.0` e um aviso é gravado nos
metadados.

## 6. Harmonização

A série é ancorada no MODIS:

```text
if MODIS count > 0:  harmonized = MODIS count
else if VIIRS > 0:   harmonized = round(VIIRS count / factor[region, month])
else:                harmonized = 0
```

MODIS e VIIRS nunca são somados para o mesmo mês. Um cluster que contém ambos os
sensores contribui para a contagem bruta do MODIS e é usado como âncora do MODIS.

## 7. Anomalia e linha de base

Linha de base: `BASELINE_START_YEAR`–`BASELINE_END_YEAR` (padrão 2003–2025).

Para cada mês:

```text
anomaly_pct = (value - mean_same_month_baseline) / mean_same_month_baseline * 100
```

- Meses sem média da linha de base ou sem valor são `null`.
- O ano corrente é parcial; sua anomalia compara os mesmos meses que existem no ano
  corrente com as médias do mesmo mês da linha de base.
- A tendência é uma regressão linear sobre os totais anuais completos da linha de
  base, expressa como % da média por década.
- O pico histórico usa apenas anos completos da linha de base.
- A estação crítica é o conjunto de meses com média climatológica ≥ 50% da média
  mensal de pico.

## 8. Saídas

`data/real/`:

| Arquivo | Conteúdo |
|---|---|
| `calendario.json` | Matriz, séries, métricas, insights, metadados |
| `hotspots.geojson` | Todos os clusters na(s) região(ões) selecionada(s) |
| `pontos-recentes.json` | Amostra do mapa limitada por `MAX_MAP_POINTS` |
| `run-meta.json` | Contagens de entrada, clusters, resumo da calibração, avisos |
| `raw/hotspots.jsonl` | Focos normalizados para merges NRT futuros |

`calendario.json` segue o schema da base de pesquisa:

- `meta`, `months`, `years`, `baseline_years`, `regions`;
- `calendar[region]`: `counts`, `anomaly_pct`, `raw_modis`, `raw_viirs`,
  `viirs_share_pct`;
- `series[region]`: `annual`, `climatology`, `season`;
- `metrics[region]`;
- `insights[region]`.

## 9. Fluxo de dados reais

Prepare o banco SQLite (o script faz scraping dos CSVs públicos anuais por país do
FIRMS, importa-os para `data/db/firms.sqlite`, busca apenas a janela NRT atual pela
API e então reconstrói `data/real`):

```bash
npm run bootstrap
```

Os CSVs históricos ficam em `data/raw/country/`. A importação é retomável por meio de
`data/runtime/import.json`. `data/db/firms.sqlite` é a fonte de verdade histórica;
`hotspots.geojson` exporta apenas a janela recente (`HOTSPOTS_EXPORT_MONTHS`, padrão
24).

Backfill histórico legado pela FIRMS Area API (fontes `*_SP`):

```bash
npm run backfill -- --start 2000-11-01 --end 2026-10-31 \
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP \
  --bbox=-74,-34,-34,6
```

O backfill usa blocos de 5 dias (o máximo da API), checkpoints em
`data/runtime/backfill.json` e grava um CSV por bloco em `data/raw/<source>/`.
Reexecutar retoma e pula os blocos concluídos. Cobertura das fontes:

| Fonte | Período |
|---|---|
| `MODIS_SP` | a partir de 2000-11-01 |
| `VIIRS_SNPP_SP` | 2012-01-20 a 2026-11-02 |
| `VIIRS_NOAA20_SP` | a partir de 2018-04-01 |
| `VIIRS_NOAA21_SP` | a partir de 2023-03-01 |

A FIRMS API é limitada a 5 dias por requisição e 5.000 transações por janela de 10
minutos. Requisições de cinco dias podem contar como múltiplas transações.
Para uma área menor, use `--region pantanal` ou `--bbox=...`; o plano completo do
Brasil com 4 fontes tem ~3.900 blocos e pode consumir bastante disco/tempo.

Depois do backfill:

1. Execute `node pipeline/src/cli.js pipeline --input data/raw --out data/real`.
2. Troque a API para o modo real.

Importação manual de arquivos:

1. Baixe os CSVs do arquivo MODIS/VIIRS do FIRMS para a área e o período.
2. Coloque-os em `data/raw/` (subdiretórios permitidos).
3. Execute `node pipeline/src/cli.js pipeline --input data/raw --out data/real`.
4. Troque a API para o modo real.

NRT:

1. Defina `FIRMS_MAP_KEY` e `NRT_ENABLED=true`.
2. O agendador busca os últimos `NRT_DAYS` para cada região/fonte configurada.
3. Novos focos normalizados são mesclados em `raw/hotspots.jsonl`.
4. Todo o histórico armazenado é reagrupado e o conjunto de dados real é reconstruído.
5. Em caso de falha, o conjunto de dados real anterior é mantido.

## 10. Ressalvas

- Sem estimativa de área queimada; as contagens de focos são um proxy de atividade.
- Sem máscara de nuvem ou de cobertura do solo no Active Fire CSV.
- Os fatores de calibração valem apenas o quanto valem os dados de sobreposição;
  valide com um cientista de incêndios antes do uso operacional.
- As regiões padrão são seis biomas brasileiros. Adicione polígonos em
  `config/regions.json` para outras AOIs.
- Históricos globais/longos devem usar um banco ou um pipeline em lote baseado em
  tiles em vez de reagrupar todo o JSONL a cada atualização NRT.
- `data/real/raw/hotspots.jsonl` é a fonte de verdade histórica para o NRT.
  Apagá-lo significa que a próxima execução NRT só pode reconstruir a partir dos dias
  que buscou.
- O Suomi NPP é excluído das fontes NRT padrão após o encerramento dos dados em 2026;
  use NOAA-20/NOAA-21.
