**English** · [Português](REAL-DATA.pt-BR.md)

# Real data and NRT API (DEV-09)

This NestJS project serves the existing mock API and now also supports real FIRMS
data through a separate pipeline worker.

> **Postgres (production):** the API connects to Postgres for health checks,
> schema migrations and the operational run log (`operation_runs`, exposed at
> `GET /api/runs`). The analytical hotspot history still lives in SQLite and the
> generated `data/real` JSON files in this phase. Moving that series to
> Postgres/PostGIS is tracked in `docs/REQUISITOS.md`.

> **Global ingestion:** a separate worldwide pipeline downloads every FIRMS
> country CSV into `data/db/global.sqlite` and exposes `/api/global/*`. See
> [`docs/GLOBAL.md`](../../docs/GLOBAL.md). It does not alter the Brazil dataset
> used by the web.

## Data modes

| Mode | Source | How to enable |
|---|---|---|
| `mock` | `data/mock/` | Default |
| `real` | `data/real/` | Generate the dataset, then `POST /api/mode` |

`GET /api/config` reports the active mode and availability. A mode saved in
`data/runtime/mode.json` takes precedence over `DATA_SOURCE`.

## SQLite historical store

`data/db/firms.sqlite` holds normalized historical hotspots imported from the
public FIRMS yearly country CSVs. `data/real` is regenerated from it by
`npm run bootstrap`, `npm run pipeline` or `npm run nrt`. The API still reads the
JSON files, so no API client changes are required.

```text
data/db/firms.sqlite        normalized hotspots + monthly clusters
data/raw/country/           scraped historical CSVs
data/runtime/import.json    CSV import checkpoint
data/real/                  generated dataset consumed by the API
```

`hotspots.geojson` exports only the last `HOTSPOTS_EXPORT_MONTHS` (default 24)
months to keep the file small. The complete history remains queryable in SQLite.

## Endpoints

Existing endpoints keep their contracts:

| Method | Route | Notes |
|---|---|---|
| GET | `/api/health` | Includes active `dataSource` |
| GET | `/api/meta` | Active dataset metadata |
| GET | `/api/regions` | Active regions |
| GET | `/api/regions.geojson` | Active regions as GeoJSON |
| GET | `/api/calendar?region=&from=&to=` | Calendar and metrics |
| GET | `/api/hotspots?region=&from=&to=&sensor=&bbox=&limit=` | GeoJSON hotspots |
| GET | `/api/export.csv?region=&from=&to=` | Calendar CSV |

New real-data endpoints:

| Method | Route | Notes |
|---|---|---|
| GET | `/api/config` | Mode, availability, active period, regions |
| GET | `/api/datasets` | Availability and latest `run-meta` |
| POST | `/api/mode` | Switch `{"mode":"mock"}` / `{"mode":"real"}` |
| POST | `/api/ingestion/run` | Run historical pipeline from `data/raw` |
| GET | `/api/nrt/status` | Scheduler state and `keyConfigured` |
| POST | `/api/nrt/refresh` | Trigger an NRT refresh (202) |
| GET | `/api/export/hotspots.csv?region=&from=&to=&sensor=&bbox=` | Filtered hotspot CSV |
| GET | `/api/runs?limit=20` | Operational run history from Postgres (admin when `ADMIN_TOKEN` is set) |
| GET | `/api/global/status` | Worldwide ingestion coverage and job state |
| GET | `/api/global/calendar?region=&bbox=&from=&to=` | Global grid/AOI calendar |
| GET | `/api/global/hotspots?region=&bbox=&from=&to=&sensor=` | Global hotspot search |
| POST | `/api/global/ingest` | Start worldwide ingestion (admin) |

## Admin protection

Set `ADMIN_TOKEN` to protect:

- `POST /api/mode`
- `POST /api/ingestion/run`
- `POST /api/nrt/refresh`

Send `Authorization: Bearer <token>` or `X-Admin-Token: <token>`.

## Historical ingestion

### Bootstrap the SQLite database

`npm run bootstrap` is the one-command way to populate a fresh install. The
historical store is `data/db/firms.sqlite`; `data/real` is generated from it.

When the database is empty, the script:

1. scrapes the public yearly country CSV index linked from the FIRMS Archive
   Download page (`/data/country/yearly_summary_files.txt`);
2. downloads the historical CSVs into `data/raw/country/`;
3. streams all CSVs into SQLite, with a resumable import checkpoint;
4. fetches **only the current NRT window** through the FIRMS Area API;
5. clusters/aggregates the database and rebuilds `data/real`.

The public country index covers MODIS C6.1, VIIRS S-NPP and VIIRS NOAA-20. The
Brazil history is ~48 CSVs and ~3.2 GB. NOAA-21 is covered by the current NRT
window because the country index has no yearly NOAA-21 files.

```bash
npm run bootstrap

# Inspect the plan first
npm run bootstrap -- --dry-run

# Pilot: two CSVs and no current API call
npm run bootstrap -- --max-files 2 --no-current

# Re-run/complete the import even if the database exists
npm run bootstrap -- --force

# Regenerate data/real from SQLite without new downloads/API
npm run bootstrap -- --rebuild-only

# Recreate the database and checkpoints
npm run bootstrap -- --reset

# Rebuild even if some downloads/imports failed
npm run bootstrap -- --allow-partial
```

If the historical import is incomplete, the script keeps the previous
`data/real` dataset unless `--allow-partial` is passed.

Useful environment settings:

```dotenv
FIRMS_DB_PATH=./data/db/firms.sqlite
FIRMS_COUNTRY=Brazil
FIRMS_HISTORY_START_YEAR=2000
HOTSPOTS_EXPORT_MONTHS=24
# Optional: load region polygons from another GeoJSON file.
# REGIONS_FILE=./pipeline/config/regions.json
```

`FIRMS_COUNTRY` accepts any country listed by the FIRMS yearly country index.
For other areas, `backfill --bbox=west,south,east,north` accepts any FIRMS Area
API extent. The API's `/api/hotspots` and hotspot CSV export also accept a free
`bbox`. Note that calendars and the web UI are still organized around the
configured regions; see `docs/REQUISITOS.md` for the global-scope gap.

The FIRMS Archive Download form still requires an authenticated Earthdata/email
session, but the yearly country files used here are public and listed by the
same site.

### Legacy: automated backfill through the Area API

`npm run bootstrap` does not use this path anymore. It remains available for
bulk chunk downloads when you explicitly want the Area API instead of the public
yearly country CSVs.

The project can download historical standard-processing data directly through
the FIRMS Area API using the existing `FIRMS_MAP_KEY`:

```bash
npm run backfill -- --start 2000-11-01 --end 2026-10-31 `
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP `
  --bbox=-74,-34,-34,6
```

- Chunks are limited to **5 days** by the FIRMS API.
- The checkpoint is `data/runtime/backfill.json`; reruns resume automatically.
- Files are written to `data/raw/<source>/<start>_<end>.csv`.
- Use `--region pantanal` or `--region cerrado` for a smaller AOI.
- Use `--dry-run` to see the plan and `--max-requests N` for a pilot.
- The full Brazil/4-source plan is ~3,900 chunks; prefer one region/source at a
  time if disk/time is limited.

After the backfill:

```bash
npm run pipeline
```

### Manual archive import

1. Download MODIS/VIIRS FIRMS archive CSVs.
2. Put them under `data/raw/country/` (subdirectories are supported).
3. Run from the project root:

```bash
npm run pipeline
```

To import a different directory, use
`node pipeline/src/cli.js pipeline --input data/raw`. If SQLite exists, the
import and the dataset rebuild use the database.

Or through the API:

```bash
curl -X POST http://127.0.0.1:3000/api/ingestion/run \
  -H "Content-Type: application/json" \
  -d '{"inputDir":"data/raw"}'
```

The pipeline writes `data/real/`; then switch:

```bash
curl -X POST http://127.0.0.1:3000/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"real"}'
```

## NRT

Configure the project root `.env`:

```dotenv
FIRMS_MAP_KEY=...
NRT_ENABLED=true
NRT_INTERVAL_MINUTES=180
NRT_DAYS=2
NRT_REGIONS=pantanal,cerrado
```

The scheduler fetches the last `NRT_DAYS` (maximum 5 per FIRMS Area API). When
`data/db/firms.sqlite` exists, it upserts only those current hotspots into
SQLite, recomputes the affected months and rebuilds `data/real` from the full
database. Without SQLite, it keeps the legacy `data/real/raw/hotspots.jsonl`
merge behavior.

Manual trigger:

```bash
curl -X POST http://127.0.0.1:3000/api/nrt/refresh
curl http://127.0.0.1:3000/api/nrt/status
```

If a refresh fails, the previous real dataset is kept and `lastError` is recorded.

## Tests

```bash
npm test              # unit tests
npm run test:e2e      # existing + real-mode/API tests
npm run pipeline:test # pipeline worker tests
npm run build
```

## DEV-09 checklist

- [x] Separate mock and real datasets.
- [x] Real mode only when `data/real/calendario.json` exists.
- [x] Historical FIRMS CSV ingestion.
- [x] NRT fetch, merge and rebuild.
- [x] NRT scheduler and status/trigger API.
- [x] Failure keeps the last good dataset.
- [x] Filtered hotspot CSV export.
- [x] Tests with fake FIRMS fetch and real-mode API.
- [ ] Visual web dashboard (out of scope).
- [ ] Production-scale global history (next step: DuckDB/PostGIS/tiles).

## Attribution

Real data: NASA FIRMS / NASA Earthdata (MODIS C6.1 and VIIRS 375 m). Follow FIRMS
acknowledgment and disclaimer requirements when redistributing data or derived
products.
