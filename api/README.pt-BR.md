[English](README.md) · **Português**

# API do Carcará Orbit

API NestJS 12 + TypeScript para monitoramento de focos de incêndio. Ela serve o
conjunto de dados do Brasil (trilha legada) e a trilha global do FIRMS usada pelo
painel web.

## Requisitos

- Node.js 24
- npm
- PostgreSQL 16 (opcional para desenvolvimento; sem ele a API inicia com a
  persistência desativada)

## Configuração

```bash
npm ci
cp .env.example .env
# edit DB_PASSWORD, FIRMS_MAP_KEY and the other variables
npm run db:migrate
npm run start:dev
```

A API escuta em `http://localhost:3000/api`.

## Principais scripts

| Comando | Descrição |
| --- | --- |
| `npm run start:dev` | Servidor de desenvolvimento com watch mode |
| `npm run build` | Compila o app NestJS |
| `npm run start:prod` | Executa o app compilado |
| `npm run lint` | Lint com verificação de tipos (oxlint) |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:e2e` | Testes end-to-end |
| `npm run pipeline:test` | Testes do pipeline FIRMS |
| `npm run db:migrate` | Aplica as migrations pendentes do Postgres |

## Trilhas de dados

- **Brasil (legada):** `data/db/firms.sqlite` e `data/real/`, controladas por
  `DATA_SOURCE`. Endpoints: `/api/hotspots`, `/api/regions`, `/api/calendar`,
  `/api/export.csv`.
- **Global:** o agregado DuckDB `data/db/aggregates.sqlite`, servido por
  `/api/global/aggregates` e `/api/global/hotspots`. O painel usa esta trilha.
  Veja [`../docs/GLOBAL.pt-BR.md`](../docs/GLOBAL.pt-BR.md).

O diretório `data/` é persistido no volume Docker `api_data` em produção.

## Pipeline global

```bash
# plan the worldwide country CSV download
npm run global -- --dry-run --countries all --grid 10

# download the historical CSVs (resumable)
npm run global -- --countries all --grid 10

# fetch the open year through the FIRMS Area API
python scripts/fetch_current_year.py --year 2026 --dry-run
python scripts/fetch_current_year.py --year 2026

# build the compact aggregate (DuckDB)
python scripts/global_aggregate.py --raw data/raw/global \
  --regions data/runtime/global-regions.json \
  --out data/db/aggregates.sqlite --tmp data/db/duckdb-tmp

# historical backfill through the FIRMS Area API
npm run backfill -- --start 2000-11-01 --end 2026-10-31 \
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP \
  --bbox=-74,-34,-34,6

# one-shot NRT refresh
npm run nrt
```

`FIRMS_MAP_KEY` é obrigatória para o NRT, para o job do ano corrente e para o
`backfill`; o download histórico de CSVs por país não precisa dela.

## Principais endpoints

| Rota | Descrição |
| --- | --- |
| `GET /api/health` | Verificação de saúde |
| `GET /api/meta` | Modo da API e metadados |
| `GET /api/global/status` | Cobertura global, grid, calibração e status de ingestão |
| `GET /api/global/aggregates` | Agregado harmonizado de todas as células globais |
| `GET /api/global/hotspots` | Focos globais (amostra do agregado) |
| `POST /api/global/ingest` | Inicia a ingestão global em background (admin) |
| `GET /api/runs` | Histórico de execuções operacionais |

## Ambiente

As principais variáveis são `DB_*` (ou `DATABASE_URL`), `FIRMS_MAP_KEY`,
`GLOBAL_DB_PATH`, `GLOBAL_RAW_DIR`, `AGGREGATES_DB_PATH`,
`GLOBAL_REGIONS_FILE`, `GLOBAL_GRID_DEGREES` e `DATA_SOURCE`. Veja
[`../docs/DEPLOY.pt-BR.md`](../docs/DEPLOY.pt-BR.md) para a lista completa e os valores de
produção.

## Mais documentação

- [`../docs/GLOBAL.pt-BR.md`](../docs/GLOBAL.pt-BR.md) — ingestão global e agregado.
- [`docs/REAL-DATA.pt-BR.md`](docs/REAL-DATA.pt-BR.md) — dados reais e NRT.
- [`docs/EXPLAIN.pt-BR.md`](docs/EXPLAIN.pt-BR.md) — endpoint de explicação.
- [`pipeline/README.pt-BR.md`](pipeline/README.pt-BR.md) — pipeline FIRMS.
