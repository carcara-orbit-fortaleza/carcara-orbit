# Ingestão global (API)

A ingestão global é uma trilha separada do dataset Brasil usado pela web. Ela
baixa o arquivo histórico mundial da NASA FIRMS, grava em um SQLite próprio
(`data/db/global.sqlite`) e expõe consultas globais em `/api/global/*`.

> A web não foi alterada. Nesta entrega o escopo global está disponível na API;
> a interface continua centrada no Brasil e nas seis regiões existentes.

## Fonte de dados

O índice público de CSVs anuais por país da FIRMS
(`/data/country/yearly_summary_files.txt`) contém, no momento desta implementação:

- **238 países/territórios**;
- **10.095 arquivos**;
- **2000–2025**;
- **~43,5 GB** de CSV;
- fontes MODIS, VIIRS S-NPP e VIIRS JPSS1/NOAA-20.

O ano corrente é complementado pela janela NRT da API FIRMS (requer
`FIRMS_MAP_KEY`), consultada em tiles globais para não gerar milhares de
requisições por célula.

## Como funciona

1. **Download**: baixa todos os CSVs para `data/raw/global/<país>/<fonte>/`,
   com checkpoint em `data/runtime/global-download.json`.
2. **Importação**: importa para `data/db/global.sqlite`, atribuindo cada foco a
   uma célula da grade mundial (padrão 10°, configurável de 5° a 60°).
3. **Clusters**: agrega detecções próximas no tempo/espaço.
4. **Calibração**: calcula fatores VIIRS/MODIS por célula e mês, gravando
   `data/runtime/global-calibration.json`.
5. **Metadados da grade**: grava `data/runtime/global-regions.json`.
6. **NRT opcional**: busca a janela atual em tiles de 30° e faz upsert.

O processo é retomável: cada arquivo baixado/importado fica em checkpoint. Se a
VPS reiniciar, basta iniciar novamente; ele continua de onde parou.

## CLI

```bash
cd api

# Ver o plano (não baixa dados)
npm run global -- --dry-run --countries all --grid 10 --json

# Piloto: 20 arquivos
npm run global -- --countries all --max-files 20 --grid 10

# Carga histórica completa (pode levar horas/dias e ~43 GB)
npm run global -- --countries all --start-year 2000 --end-year 2025 --grid 10

# Incluir a janela NRT atual (requer FIRMS_MAP_KEY)
npm run global -- --countries all --current --days 2 --grid 10

# Reclusterizar/calibrar sem baixar novamente
npm run global -- --rebuild-only --grid 10

# Recomeçar do zero (apaga o SQLite global e os checkpoints)
npm run global -- --reset
```

O comando `global` também aparece em `node pipeline/src/cli.js --help`.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/global/status` | Cobertura, clusters, grade, calibração e status da ingestão |
| GET | `/api/global/regions?bbox=&limit=` | Células da grade com dados |
| GET | `/api/global/regions.geojson?bbox=&limit=` | Células como polígonos GeoJSON |
| GET | `/api/global/calendar?region=&bbox=&from=&to=` | Calendário harmonizado por célula ou bbox |
| GET | `/api/global/hotspots?region=&bbox=&from=&to=&sensor=&limit=` | Focos globais em GeoJSON |
| GET | `/api/global/export/hotspots.csv?...` | CSV dos focos filtrados |
| GET | `/api/global/export/calendar.csv?...` | CSV do calendário |
| GET | `/api/global/ingest/status` | Status do job de ingestão |
| POST | `/api/global/ingest` | Dispara a ingestão em background (admin) |
| POST | `/api/global/ingest/cancel` | Cancela o job (admin) |

Exemplos:

```bash
# Status
curl http://localhost:3000/api/global/status

# Célula de 10° que contém o Pantanal
curl "http://localhost:3000/api/global/calendar?region=g_s20_w60&from=2000&to=2026"

# Qualquer bbox do mundo
curl "http://localhost:3000/api/global/calendar?bbox=-74,-34,-34,6&from=2000&to=2026"
curl "http://localhost:3000/api/global/hotspots?bbox=-74,-34,-34,6&from=2024&to=2026&limit=100"

# Ingestão piloto em background
curl -X POST http://localhost:3000/api/global/ingest \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"countries":"all","maxFiles":20,"gridDegrees":10}'
```

### Corpo do POST `/api/global/ingest`

| Campo | Padrão | Observação |
| --- | --- | --- |
| `countries` | `"all"` | `"all"` ou lista (`["Brazil","Peru"]`) |
| `startYear` | 2000 | |
| `endYear` | ano atual - 1 | |
| `sources` | MODIS/VIIRS históricos | códigos `MODIS_SP`, `VIIRS_SNPP_SP`, etc. |
| `gridDegrees` | 10 | 5–60 |
| `nrtTileDegrees` | 30 | 5–60 |
| `maxFiles` | ilimitado | piloto/resume |
| `maxImportFiles` | ilimitado | piloto/resume |
| `includeCurrent` | `false` | requer `FIRMS_MAP_KEY` |
| `currentDays` | 2 | 1–5 |
| `allowPartial` | `true` | `false` falha se downloads/imports incompletos |
| `dryRun` | `false` | só monta o plano |
| `reset` | `false` | apaga o banco/checkpoints globais |
| `rebuildOnly` | `false` | não baixa; só clusteriza/calibra |

## Grade e calibração

- A grade padrão de 10° gera 648 células; cada célula é uma região global com
  polígono, centro, cor e ID estável (ex.: `g_s30_w60`).
- A calibração usa os mesmos fatores VIIRS/MODIS do pipeline Brasil, mas por
  célula e mês. Células sem sobreposição suficiente usam fator 1,0 e aparecem
  como baixa confiança.
- O calendário global aplica o fator de cada célula antes de somar as contagens
  de uma bbox que atravessa várias células.

## Operação

- O banco global fica em `data/db/global.sqlite`, separado do
  `data/db/firms.sqlite` do Brasil, e é persistido no volume `api_data`.
- Downloads e importação são sequenciais e respeitam os limites/checkpoints.
- O job é registrado em `operation_runs` no Postgres (quando configurado) e em
  `data/runtime/global-ingestion.json`.
- Log do job: `data/runtime/global-ingestion.log`.
- Recomenda-se rodar a primeira carga em um piloto (`maxFiles`) e acompanhar
  espaço em disco; a carga completa é da ordem de dezenas de GB.
