**English** · [Português](README.pt-BR.md)

# Carcará Orbit API

NestJS 12 + TypeScript API for fire hotspot monitoring. It serves the Brazil
dataset (legacy track) and the global FIRMS track used by the web dashboard.

## Requirements

- Node.js 24
- npm
- PostgreSQL 16 (optional for development; without it the API starts with
  persistence disabled)

## Setup

```bash
npm ci
cp .env.example .env
# edit DB_PASSWORD, FIRMS_MAP_KEY and the other variables
npm run db:migrate
npm run start:dev
```

The API listens on `http://localhost:3000/api`.

## Main scripts

| Command | Description |
| --- | --- |
| `npm run start:dev` | Development server with watch mode |
| `npm run build` | Compiles the NestJS app |
| `npm run start:prod` | Runs the compiled app |
| `npm run lint` | Type-aware lint (oxlint) |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests |
| `npm run pipeline:test` | FIRMS pipeline tests |
| `npm run db:migrate` | Applies pending Postgres migrations |

## Data tracks

- **Brazil (legacy):** `data/db/firms.sqlite` and `data/real/`, controlled by
  `DATA_SOURCE`. Endpoints: `/api/hotspots`, `/api/regions`, `/api/calendar`,
  `/api/export.csv`.
- **Global:** the DuckDB aggregate `data/db/aggregates.sqlite`, served by
  `/api/global/aggregates` and `/api/global/hotspots`. The dashboard uses this
  track. See [`../docs/GLOBAL.md`](../docs/GLOBAL.md).

The `data/` directory is persisted in the `api_data` Docker volume in
production.

## Global pipeline

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

`FIRMS_MAP_KEY` is required for NRT, for the current-year job and for
`backfill`; the historical country CSV download does not need it.

## Main endpoints

| Route | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/meta` | API mode and metadata |
| `GET /api/global/status` | Global coverage, grid, calibration and ingestion status |
| `GET /api/global/aggregates` | Harmonized aggregate for every global cell |
| `GET /api/global/hotspots` | Global hotspots (aggregate sample) |
| `POST /api/global/ingest` | Starts global ingestion in the background (admin) |
| `GET /api/runs` | Operational run history |

## Environment

The main variables are `DB_*` (or `DATABASE_URL`), `FIRMS_MAP_KEY`,
`GLOBAL_DB_PATH`, `GLOBAL_RAW_DIR`, `AGGREGATES_DB_PATH`,
`GLOBAL_REGIONS_FILE`, `GLOBAL_GRID_DEGREES` and `DATA_SOURCE`. See
[`../docs/DEPLOY.md`](../docs/DEPLOY.md) for the full list and production
values.

## More docs

- [`../docs/GLOBAL.md`](../docs/GLOBAL.md) — global ingestion and aggregate.
- [`docs/REAL-DATA.md`](docs/REAL-DATA.md) — real data and NRT.
- [`docs/EXPLAIN.md`](docs/EXPLAIN.md) — explanation endpoint.
- [`pipeline/README.md`](pipeline/README.md) — FIRMS pipeline.
