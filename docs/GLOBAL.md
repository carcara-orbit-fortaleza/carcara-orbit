# Ingestão global (API)

A trilha global usada pela web (globo da home e painel) tem duas camadas:

1. **CSVs históricos da NASA FIRMS** em `data/raw/global/<país>/<fonte>/`
   (2000–2025, ~43,5 GB).
2. **Agregado compacto** em `data/db/aggregates.sqlite`, gerado com DuckDB:
   contagens por célula × ano × mês × sensor, fatores de calibração, metadados
   da grade e uma amostra dos focos mais recentes.

A API expõe o agregado em `/api/global/aggregates`; o painel carrega todas as
células em uma única requisição e calcula calendário, anomalias e AOI no
cliente. O SQLite linha a linha (`data/db/global.sqlite`) continua atendendo os
endpoints legados (`/status`, `/regions`, `/calendar`, exportações), mas não é
mais o caminho do calendário global.

> O globo da home consulta `/api/global/hotspots`; o painel consulta
> `/api/global/aggregates` + `/api/global/hotspots`.

## Fonte de dados

O índice público de CSVs anuais por país da FIRMS
(`/data/country/yearly_summary_files.txt`) contém, no momento desta implementação:

- **238 países/territórios**;
- **10.095 arquivos**;
- **2000–2025**;
- **~43,5 GB** de CSV;
- fontes MODIS, VIIRS S-NPP, VIIRS NOAA-20 e VIIRS NOAA-21.

O **ano corrente** vem da API de disponibilidade do FIRMS
(`/api/data_availability/csv/<FIRMS_MAP_KEY>/all`, com cache de 6 h na API).
Ele entra no calendário como a coluna mais recente, ainda sem dados
consolidados; a janela NRT de focos continua vindo de `/api/global/hotspots`.

## Como funciona

1. **Download**: baixa todos os CSVs para `data/raw/global/<país>/<fonte>/`,
   com checkpoint em `data/runtime/global-download.json`.
2. **Agregação (DuckDB)**: lê os CSVs em streaming e grava
   `data/db/aggregates.sqlite` com:
   - `cells`: metadados das 648 células de 10°;
   - `cell_month`: MODIS, VIIRS, total bruto, fator e total harmonizado;
   - `calibration`: fator VIIRS/MODIS por célula/mês e confiança;
   - `recent_points`: até 100 focos recentes por célula (mapa);
   - `meta`: cobertura, versão do método, filtros e totais.
3. **API**: `/api/global/aggregates` monta as matrizes anuais/mensais de todas
   as células; `/api/global/hotspots` usa `recent_points` quando o agregado
   existe.
4. **Painel**: usa as 24 células mais ativas nos chips/calculadora e o conjunto
   completo no recorte por AOI.
5. **NRT opcional**: a ingestão linha a linha ainda pode buscar a janela atual
   em tiles de 30° e fazer upsert em `global.sqlite`.

O download é retomável: cada arquivo baixado fica em checkpoint. Se a VPS
reiniciar, basta iniciar novamente; ele continua de onde parou. A agregação é
idempotente: regerar `aggregates.sqlite` substitui o arquivo inteiro.

## CLI

```bash
cd api

# Ver o plano (não baixa dados)
npm run global -- --dry-run --countries all --grid 10 --json

# Download histórico completo (pode levar horas e ~43 GB)
npm run global -- --countries all --start-year 2000 --end-year 2025 --grid 10

# Agregado completo (DuckDB), direto no volume da API
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/scripts:/scripts:ro" \
  python:3.12-slim \
  sh -c 'pip install --quiet duckdb && python /scripts/global_aggregate.py \
    --raw /data/raw/global \
    --regions /data/runtime/global-regions.json \
    --out /data/db/aggregates.sqlite \
    --tmp /data/db/duckdb-tmp \
    --threads 4 --memory-limit 6GB'

# Piloto rápido (20–60 arquivos)
# ... acrescente --max-files 60

# Incluir a janela NRT atual (requer FIRMS_MAP_KEY; caminho legado)
npm run global -- --countries all --current --days 2 --grid 10
```

O comando `global` também aparece em `node pipeline/src/cli.js --help`.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/global/status` | Cobertura, clusters, grade, calibração e status da ingestão |
| GET | `/api/global/aggregates` | Agregado harmonizado de todas as células (calendário/AOI) |
| GET | `/api/global/regions?bbox=&limit=` | Células da grade com dados (SQLite legado) |
| GET | `/api/global/regions.geojson?bbox=&limit=` | Células como polígonos GeoJSON |
| GET | `/api/global/calendar?region=&bbox=&from=&to=` | Calendário harmonizado por célula ou bbox (legado) |
| GET | `/api/global/hotspots?region=&bbox=&from=&to=&sensor=&limit=` | Focos globais em GeoJSON (usa o agregado) |
| GET | `/api/global/export/hotspots.csv?...` | CSV dos focos filtrados |
| GET | `/api/global/export/calendar.csv?...` | CSV do calendário |
| GET | `/api/global/ingest/status` | Status do job de ingestão |
| POST | `/api/global/ingest` | Dispara a ingestão em background (admin) |
| POST | `/api/global/ingest/cancel` | Cancela o job (admin) |

Exemplos:

```bash
# Status
curl http://localhost:3000/api/global/status

# Agregado completo (uma requisição)
curl http://localhost:3000/api/global/aggregates

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

## Web

- **Globo da home** (`web/src/data/hotspots.ts`): usa
  `/api/global/hotspots` com bbox mundial.
- **Painel** (`web/src/painel/data/api.ts`): carrega **todas as células** com
  `/api/global/aggregates` em uma única requisição. As 24 mais ativas aparecem
  nos chips/calculadora; o mapa e o polígono (AOI) usam o conjunto completo.
  Os focos recentes vêm de `/api/global/hotspots` (amostra do agregado).
- O ano corrente vem da disponibilidade do FIRMS e aparece no calendário mesmo
  antes de o ano estar consolidado no agregado.
- A grade do painel é a de 10°. Para agregar outro recorte, use `bbox` nos
  endpoints globais.

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
