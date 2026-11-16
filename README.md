**English** · [Português](README.pt-BR.md)

# Carcará Orbit

Carcará Orbit monorepo: a fire hotspot monitoring panel and API. The current
web app uses Brazilian data and regions; the API also exposes a global ingestion
and query track (see [`docs/GLOBAL.md`](./docs/GLOBAL.md) and
[`docs/REQUISITOS.md`](./docs/REQUISITOS.md)).

| Folder | Stack | Description |
| --- | --- | --- |
| [`api/`](./api) | NestJS 12 · TypeScript · Node 24 | Hotspots, calendar, regions, export and FIRMS pipeline API |
| [`web/`](./web) | React 19 · Vite 7 · Tailwind 4 | Public site and dashboard (`/dashboard`) |

The original code lived in the
[carcara-api](https://github.com/carcara-orbit-fortaleza/carcara-api) and
[carcara-web](https://github.com/carcara-orbit-fortaleza/carcara-web)
repositories; this monorepo is now the single source of truth.

The infrastructure follows the [Baseware](https://github.com/platusforge/baseware)
pattern: three Compose files (base, development override and production
override), Postgres 16 in a container with daily backups and multi-stage
Dockerfiles. In production, nginx serves the SPA and proxies `/api`; the
Traefik instance already running on the VPS terminates TLS and routes the
subdomain to `web`. CI/CD verifies the code, builds the images and deploys over
SSH to the VPS.

## How the pieces connect

- **Development:** the browser calls the API at `http://localhost:3000/api`
  (`VITE_API_URL`). The API allows the `http://localhost:5173` origin through
  `CORS_ORIGIN` and accepts session cookies (`credentials: true`).
- **Production:** the frontend is built with `VITE_API_URL=/api`, so every call
  is relative and goes through the `web` nginx, which forwards `/api/*` to
  `api:3000` on the internal Docker network. The API is **not** published on the
  host.
- **Data:** the home globe and the dashboard consume the global track
  (`/api/global/hotspots`, `/api/global/aggregates`). The calendar comes from
  the `data/db/aggregates.sqlite` aggregate; the row-level SQLite database
  (`data/db/global.sqlite`) serves the legacy endpoints. `/api/hotspots`,
  `/api/regions` and `/api/calendar` remain available for the legacy Brazil
  track, controlled by `DATA_SOURCE`.
- Dashboard session cookies work in both modes (CORS with credentials in dev,
  same origin in production).

## Quickstart (Docker)

Requirements: Docker Desktop with Compose v2.

```bash
cp .env.example .env
# edit .env (DB_PASSWORD, FIRMS_MAP_KEY, ports, etc.)
docker compose up --build
```

| Service | URL |
| --- | --- |
| Web | http://localhost:5173 |
| API (health) | http://localhost:3000/api/health |
| API (meta) | http://localhost:3000/api/meta |
| API (global) | http://localhost:3000/api/global/status |
| API (runs) | http://localhost:3000/api/runs (admin when `ADMIN_TOKEN` is set) |
| Postgres | `localhost:5432` (development only) |

The development Compose uses bind mounts and hot reload for both services. The
API entrypoint applies the Postgres migrations automatically. The globe and the
dashboard use the global track; to populate data in development:

```bash
# 1. download the historical CSVs (pilot)
docker compose exec -T api npm run global -- --countries all --max-files 20 --grid 10

# 2. build the DuckDB aggregate (see docs/GLOBAL.md)
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/api/scripts:/scripts:ro" \
  python:3.12-slim \
  sh -c 'pip install --quiet duckdb && python /scripts/global_aggregate.py \
    --raw /data/raw/global --regions /data/runtime/global-regions.json \
    --out /data/db/aggregates.sqlite --tmp /data/db/duckdb-tmp'
```

Without the aggregate, the dashboard reports that the global grid has no data.
`DATA_SOURCE=mock` only affects the legacy Brazil endpoints.

### Postgres

- `db` service (`postgres:16-alpine`) with the `postgres_data` volume, a
  healthcheck and an internal network.
- `DATABASE_URL` is assembled from `DB_USER`/`DB_PASSWORD`/`DB_NAME`
  (percent-encoded credentials).
- Migrations live in [`api/db/migrations`](./api/db/migrations) and are applied
  by the entrypoint or by `docker compose exec api npm run db:migrate`.
- The `operation_runs` table records pipeline/NRT/mode runs and feeds
  `GET /api/runs`. The analytical hotspot series remains in SQLite/`data/real`
  at this stage; migration to Postgres/PostGIS is on the roadmap.
- Production has a daily backup in the `db-backup` service (`postgres_backups`
  volume). Runbook in [`docs/DEPLOY.md`](./docs/DEPLOY.md).

### Real data (NASA FIRMS)

1. Get a `FIRMS_MAP_KEY` at <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
2. Set `FIRMS_MAP_KEY` in `.env`.
3. For real mode, set `DATA_SOURCE=real` or run
   `docker compose exec api npm run bootstrap` to download/import the history.

The `api/data` directory is the pipeline working volume (`raw`, `real`, `db`,
`runtime`) and is persisted in the `api_data` volume in production. Details in
[`api/docs/REAL-DATA.md`](./api/docs/REAL-DATA.md) and
[`api/pipeline/docs/PIPELINE.md`](./api/pipeline/docs/PIPELINE.md).

## Global ingestion (API)

The API has a global track separate from the Brazil dataset used by the web:

- downloads the worldwide FIRMS history (238 countries, ~10k CSVs, ~43.5 GB);
- aggregates the CSVs with DuckDB into `data/db/aggregates.sqlite` (cell × year ×
  month × sensor, calibration and a recent sample), without importing 1 billion
  rows;
- assigns every hotspot to a world grid (10° default, 648 cells);
- exposes the complete aggregate, hotspots and CSV under `/api/global/*`;
- uses FIRMS availability to find the current year (NRT), and can fetch that
  year in 5-day chunks with `api/scripts/fetch_current_year.py`;
- optionally keeps the legacy row-level track in `global.sqlite`.

```bash
# Plan (downloads nothing)
docker compose exec api npm run global -- --dry-run --countries all --grid 10

# Pilot with 20 files
docker compose exec api npm run global -- --countries all --max-files 20

# Full historical load (then run the DuckDB aggregate)
docker compose exec api npm run global -- --countries all
```

Main endpoints:

| Route | Description |
| --- | --- |
| `GET /api/global/status` | coverage, grid, calibration and job status |
| `GET /api/global/aggregates` | harmonized aggregate for every cell |
| `GET /api/global/calendar?region=&bbox=&from=&to=` | harmonized global calendar (legacy) |
| `GET /api/global/hotspots?region=&bbox=&from=&to=&sensor=` | global hotspots |
| `GET /api/global/export/hotspots.csv?...` | global CSV |
| `POST /api/global/ingest` | starts ingestion in the background (admin) |
| `GET /api/global/ingest/status` | job progress |

The global base is independent from the Brazil dataset: the web and its six
regions keep working unchanged. The full runbook is in
[`docs/GLOBAL.md`](./docs/GLOBAL.md).

## Production

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d --build
```

Before bringing it up:

- point the `APP_HOST` DNS record at the server;
- set `DB_PASSWORD`, `APP_HOST` and `TRAEFIK_*` in `.env` (see
  [`docs/DEPLOY.md`](./docs/DEPLOY.md#reverse-proxy-vps-traefik));
- connect `web` to the Traefik network already serving `80/443` on the VPS.

The VPS Traefik terminates TLS and forwards to the `web` nginx over the shared
network. nginx serves the SPA assets and proxies `/api` to the `api` service,
which remains unreachable from the internet. Postgres does not publish a host
port and runs with daily backups.

The globe and dashboard data come from the global track: the
`data/db/aggregates.sqlite` aggregate (DuckDB) and the original CSVs, persisted
in the `api_data` volume. The runbook is in
[`docs/DEPLOY.md`](./docs/DEPLOY.md#analytical-data-on-the-vps) and
[`docs/GLOBAL.md`](./docs/GLOBAL.md).

## CI/CD and VPS deploy

The [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) workflow:

1. validates API and web (lint, build, unit and pipeline tests);
2. starts a Postgres service, applies migrations and tests `/api/health`;
3. validates the Compose files and builds the Docker images;
4. with `DEPLOY_ENABLED=true`, copies the repo to `~/dev/carcara-orbit`, writes
   `.env` from the secrets and `TRAEFIK_*` variables, brings up the production
   Compose stack, checks health and removes `.env`.

Secrets and detailed steps: [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Development without Docker

```bash
# Postgres (optional; without it the API starts with persistence disabled)
docker compose up -d db

# API
cd api
npm ci
DATABASE_URL=postgresql://carcara:change-me-strong-password@localhost:5432/carcara \
  npm run db:migrate
npm run start:dev        # http://localhost:3000/api

# Web (another terminal)
cd web
npm ci
npm run dev              # http://localhost:5173
```

## Useful scripts

| Command | What it does |
| --- | --- |
| `docker compose up --build` | Starts development with hot reload |
| `docker compose logs -f api` | Follows the API logs |
| `docker compose exec api npm run bootstrap` | Downloads/imports the Brazil FIRMS history |
| `docker compose exec api npm run global -- --dry-run --countries all` | Plans the worldwide ingestion |
| `docker compose exec api npm run global -- --countries all --max-files 20` | Worldwide ingestion pilot |
| `docker compose exec api npm run pipeline` | Runs the historical pipeline |
| `docker compose exec api npm run db:migrate` | Applies pending migrations |
| `docker compose exec api npm test` | API unit tests |
| `docker compose exec api npm run pipeline:test` | Pipeline tests |
| `docker compose exec web npm run lint` | Frontend lint |

## Documentation

- [`docs/GLOBAL.md`](./docs/GLOBAL.md) — global ingestion, grid, endpoints and operations.
- [`docs/REQUISITOS.md`](./docs/REQUISITOS.md) — challenge compliance and roadmap.
- [`docs/DEPLOY.md`](./docs/DEPLOY.md) — VPS, secrets, migrations, backup/restore.
- [`docs/apresentacao/README.md`](./docs/apresentacao/README.md) — project presentation (EN/PT).
- [`api/docs/REAL-DATA.md`](./api/docs/REAL-DATA.md) — real data and NRT.
- [`api/pipeline/docs/PIPELINE.md`](./api/pipeline/docs/PIPELINE.md) — FIRMS pipeline.

## License

Private project of Carcará Orbit Fortaleza.
