**English** · [Português](GLOBAL.pt-BR.md)

# Global ingestion (API)

The global track used by the web app (home globe and dashboard) has two layers:

1. **Historical NASA FIRMS CSVs** in `data/raw/global/<country>/<source>/`
   (2000–2025, ~43.5 GB).
2. **Compact aggregate** in `data/db/aggregates.sqlite`, built with DuckDB:
   counts per cell × year × month × sensor, calibration factors, grid metadata
   and a sample of the most recent hotspots.

The API exposes the aggregate at `/api/global/aggregates`; the dashboard loads
every cell in a single request and computes the calendar, anomalies and AOI in
the client. The row-level SQLite database (`data/db/global.sqlite`) still serves
the legacy endpoints (`/status`, `/regions`, `/calendar`, exports), but it is no
longer the global calendar path.

> The home globe calls `/api/global/hotspots`; the dashboard calls
> `/api/global/aggregates` + `/api/global/hotspots`.

## Data source

The public FIRMS yearly country CSV index
(`/data/country/yearly_summary_files.txt`) currently contains:

- **238 countries/territories**;
- **10,095 files**;
- **2000–2025**;
- **~43.5 GB** of CSV;
- MODIS, VIIRS S-NPP, VIIRS NOAA-20 and VIIRS NOAA-21 sources.

The **current year** comes from the FIRMS availability API
(`/api/data_availability/csv/<FIRMS_MAP_KEY>/all`, cached for 6 h in the API).
When the year is still open, `api/scripts/fetch_current_year.py` downloads it in
5-day world chunks from the FIRMS Area API (standard processing plus NRT) into
`data/raw/global/current/<source>/`. The aggregate reads that directory as an
overlay, so the dashboard's current-year counts are populated instead of zero.
The year column is replaced once the yearly country archive includes the year.

## How it works

1. **Download**: fetches every CSV into `data/raw/global/<country>/<source>/`,
   with a checkpoint in `data/runtime/global-download.json`.
2. **Current year (optional)**: queries FIRMS availability, splits each sensor
   family between standard processing and NRT, and downloads the open year into
   `data/raw/global/current/<source>/`.
3. **Aggregation (DuckDB)**: reads the CSVs in streaming mode and writes
   `data/db/aggregates.sqlite` with:
   - `cells`: metadata for the 648 10° cells;
   - `cell_month`: MODIS, VIIRS, raw total, factor and harmonized total;
   - `calibration`: VIIRS/MODIS factor per cell/month and confidence;
   - `recent_points`: up to 100 recent hotspots per cell (map);
   - `meta`: coverage, method version, filters and totals.
4. **API**: `/api/global/aggregates` builds the yearly/monthly matrices for every
   cell; `/api/global/hotspots` uses `recent_points` when the aggregate exists.
5. **Dashboard**: uses the 24 most active cells for chips/calculator and the full
   set for the AOI selection.
6. **Optional legacy NRT**: the row-level ingestion can still fetch the current
   window in 30° tiles and upsert into `global.sqlite`.

The download is resumable: every downloaded file is checkpointed. If the VPS
restarts, start it again and it continues from where it stopped. The aggregation
is idempotent: rebuilding `aggregates.sqlite` replaces the whole file atomically.

## CLI

```bash
cd api

# Show the plan (downloads nothing)
npm run global -- --dry-run --countries all --grid 10 --json

# Full historical download (may take hours and ~43 GB)
npm run global -- --countries all --start-year 2000 --end-year 2025 --grid 10

# Full DuckDB aggregate, straight into the API volume
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

# Fetch the open year (2026) through the FIRMS Area API
docker run --rm --ulimit nofile=65536:65536 \
  -v carcara-orbit_api_data:/data \
  -v "$PWD/scripts:/scripts:ro" \
  -e FIRMS_MAP_KEY="$FIRMS_MAP_KEY" \
  python:3.12-slim \
  python /scripts/fetch_current_year.py --year 2026 --delay 0.8

# Quick pilot: add --max-files 60 to the aggregate, or --max-chunks 4 to the year job.
```

The FIRMS Area API is limited to 5000 transactions per 10-minute interval, and a
world 5-day request counts as several transactions. The current-year job defaults
to a 12-second delay and automatically cools down for 10 minutes when the limit
is hit; already downloaded chunks are skipped on resume.

The `global` command is also available through `node pipeline/src/cli.js --help`.

## API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/global/status` | Coverage, clusters, grid, calibration and ingestion status |
| GET | `/api/global/aggregates` | Harmonized aggregate for every cell (calendar/AOI) |
| GET | `/api/global/regions?bbox=&limit=` | Grid cells with data (legacy SQLite) |
| GET | `/api/global/regions.geojson?bbox=&limit=` | Grid cells as GeoJSON polygons |
| GET | `/api/global/calendar?region=&bbox=&from=&to=` | Harmonized calendar per cell or bbox (legacy) |
| GET | `/api/global/hotspots?region=&bbox=&from=&to=&sensor=&limit=` | Global hotspots as GeoJSON (uses the aggregate) |
| GET | `/api/global/export/hotspots.csv?...` | CSV of the filtered hotspots |
| GET | `/api/global/export/calendar.csv?...` | Calendar CSV |
| GET | `/api/global/ingest/status` | Ingestion job status |
| POST | `/api/global/ingest` | Starts ingestion in the background (admin) |
| POST | `/api/global/ingest/cancel` | Cancels the job (admin) |

Examples:

```bash
# Status
curl http://localhost:3000/api/global/status

# Complete aggregate (one request)
curl http://localhost:3000/api/global/aggregates

# 10° cell containing the Pantanal
curl "http://localhost:3000/api/global/calendar?region=g_s20_w60&from=2000&to=2026"

# Any bbox in the world
curl "http://localhost:3000/api/global/calendar?bbox=-74,-34,-34,6&from=2000&to=2026"
curl "http://localhost:3000/api/global/hotspots?bbox=-74,-34,-34,6&from=2024&to=2026&limit=100"

# Pilot ingestion in the background
curl -X POST http://localhost:3000/api/global/ingest \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"countries":"all","maxFiles":20,"gridDegrees":10}'
```

## Web

- **Home globe** (`web/src/data/hotspots.ts`): calls `/api/global/hotspots`
  with a world bbox.
- **Dashboard** (`web/src/painel/data/api.ts`): loads **every cell** from
  `/api/global/aggregates` in one request. The 24 most active cells appear in the
  chips/calculator; the map and polygon (AOI) use the full set. Recent hotspots
  come from `/api/global/hotspots` (the aggregate sample).
- The current year comes from FIRMS availability and is shown in the calendar
  even before the year is consolidated. When the current-year overlay has been
  fetched, its counts and hotspots are included.
- The dashboard grid is 10°. To aggregate another selection, use `bbox` on the
  global endpoints.

### POST `/api/global/ingest` body

| Field | Default | Note |
| --- | --- | --- |
| `countries` | `"all"` | `"all"` or a list (`["Brazil","Peru"]`) |
| `startYear` | 2000 | |
| `endYear` | current year - 1 | |
| `sources` | historical MODIS/VIIRS | codes `MODIS_SP`, `VIIRS_SNPP_SP`, etc. |
| `gridDegrees` | 10 | 5–60 |
| `nrtTileDegrees` | 30 | 5–60 |
| `maxFiles` | unlimited | pilot/resume |
| `maxImportFiles` | unlimited | pilot/resume |
| `includeCurrent` | `false` | requires `FIRMS_MAP_KEY` |
| `currentDays` | 2 | 1–5 |
| `allowPartial` | `true` | `false` fails on incomplete downloads/imports |
| `dryRun` | `false` | only builds the plan |
| `reset` | `false` | deletes the global database/checkpoints |
| `rebuildOnly` | `false` | does not download; only clusters/calibrates |

## Grid and calibration

- The default 10° grid has 648 cells; each cell is a global region with a
  polygon, center, color and stable ID (e.g. `g_s30_w60`).
- Calibration uses the same VIIRS/MODIS factors as the Brazil pipeline, but per
  cell and month. Cells without enough overlap use factor 1.0 and appear as low
  confidence.
- The global calendar applies each cell's factor before summing the counts of a
  bbox that crosses multiple cells.

## Operations

- The global database lives in `data/db/global.sqlite`, separate from Brazil's
  `data/db/firms.sqlite`, and is persisted in the `api_data` volume.
- Downloads and imports are sequential and respect limits/checkpoints.
- The job is recorded in Postgres `operation_runs` (when configured) and in
  `data/runtime/global-ingestion.json`.
- Job log: `data/runtime/global-ingestion.log`.
- Run the first load as a pilot (`maxFiles`) and watch disk space; the full load
  is tens of GB.
