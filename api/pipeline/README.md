**English** · [Português](README.pt-BR.md)

# Carcará pipeline worker

Standalone Node.js worker inside the NestJS project. It owns the heavy data work:

- normalize FIRMS MODIS/VIIRS CSV files;
- filter confidence and assign regions;
- deduplicate hotspots (1 km / 3 h);
- aggregate on a 0.1° grid;
- calibrate on the 2012–2025 overlap;
- harmonize the series;
- write the real dataset consumed by the Nest API.

It has no npm dependencies and is intentionally separate from the HTTP process.
The SQLite importer uses Node's built-in `node:sqlite` (Node.js 22.5+).

## Commands (run from the project root)

```bash
# Historical CSV import + current API window + rebuild data/real
npm run bootstrap

# Import CSVs already in data/raw/country -> SQLite -> data/real
npm run pipeline

# One-shot NRT refresh -> data/real
npm run nrt

# Worker tests
npm run pipeline:test

# Status without the API
node pipeline/src/cli.js status

# Legacy: historical chunks through the FIRMS Area API
npm run backfill -- --start 2000-11-01 --end 2026-10-31 `
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP `
  --bbox=-74,-34,-34,6
```

`data/db/firms.sqlite` is the historical store. `data/real` is generated from
it. `npm run bootstrap` does nothing when the SQLite database already has
hotspots, unless `--force` or `--reset` is used.

## How the database is populated

1. **Historical CSVs (scraping).** The script reads the public index behind the
   FIRMS Archive Download page (`/data/country/yearly_summary_files.txt`) and
   downloads the yearly country CSVs into `data/raw/country/`. Unlike the
   download form, this index does not require an Earthdata/email session.
2. **SQLite import.** Every CSV in `data/raw/country/` is streamed into
   `data/db/firms.sqlite` (`hotspots` table) in batches. The checkpoint is
   `data/runtime/import.json`, so an interrupted import resumes without
   re-reading completed files.
3. **Current data (API only).** Only the current NRT window (default 2 days,
   maximum 5 per request) is fetched through the FIRMS Area API using
   `FIRMS_MAP_KEY` and upserted into the same database.
4. **Dataset generation.** The script clusters the database by month, aggregates
   the calendar counts and regenerates `data/real`.

The Brazil history is ~48 CSVs and ~3.2 GB (MODIS C6.1, VIIRS S-NPP and VIIRS
NOAA-20). The public country index does not publish NOAA-21 yearly files; that
sensor is covered by the current NRT window.

```bash
# Populate only if empty; keep the current database otherwise
npm run bootstrap

# Inspect the download plan without downloading or writing
npm run bootstrap -- --dry-run

# Pilot: two historical CSVs, no current API call
npm run bootstrap -- --max-files 2 --no-current

# Finish/refresh even when the database already has data
npm run bootstrap -- --force

# Regenerate data/real from the SQLite database, without new downloads/API
npm run bootstrap -- --rebuild-only

# Recreate the database and checkpoints from scratch
npm run bootstrap -- --reset

# Rebuild with partial data when some downloads/imports failed
npm run bootstrap -- --allow-partial

# Import CSVs from a custom directory
npm run bootstrap -- --csv-dir data/raw
```

Useful pilot commands:

```bash
# Plan only, no downloads
node pipeline/src/cli.js backfill --start 2001-01-01 --end 2001-01-10 \
  --sources MODIS_SP --region pantanal --dry-run

# Download 10 chunks and stop
node pipeline/src/cli.js backfill --start 2010-01-01 --end 2011-12-31 \
  --sources MODIS_SP --region pantanal --max-requests 10 --json
```

Notes:

- `--bbox` needs `=` when the coordinates start with a minus sign.
- `--region pantanal` uses a configured region polygon instead of a bbox.
- The legacy backfill uses 5-day chunks and the `*_SP` sources. It is no longer
  used by `bootstrap`; prefer the country CSV scraper for historical data.
- `hotspots.geojson` exports only the last `HOTSPOTS_EXPORT_MONTHS` (default 24)
  months to keep the file small; the full history stays in SQLite.

Smoke test with synthetic FIRMS-shaped fixtures:

```bash
node pipeline/src/cli.js pipeline \
  --input pipeline/fixtures \
  --out data/real \
  --json
```

## Environment

The worker loads the project root `.env` automatically:

```dotenv
FIRMS_MAP_KEY=...
FIRMS_SOURCES=MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT
NRT_REGIONS=pantanal,cerrado
NRT_DAYS=2
```

`FIRMS_MAP_KEY` is required only for the current NRT window and for the legacy
backfill command. Historical CSV processing does not need it.

Optional database settings:

```dotenv
FIRMS_DB_PATH=./data/db/firms.sqlite
FIRMS_COUNTRY=Brazil
FIRMS_HISTORY_START_YEAR=2000
HOTSPOTS_EXPORT_MONTHS=24
```

## Outputs

```text
data/db/firms.sqlite
data/raw/country/<source>/<year>_<country>.csv
data/runtime/country-download.json
data/runtime/import.json
data/real/calendario.json
data/real/hotspots.geojson
data/real/pontos-recentes.json
data/real/run-meta.json
```

SQLite is the historical source of truth. `data/real` is regenerated from it.
The legacy `data/real/raw/hotspots.jsonl` is still written by the standalone
`npm run nrt` command; do not delete it if you rely on that path.

## Data method

The calibration uses the median `VIIRS/MODIS` ratio per month in the overlap
window, shrunk toward the regional factor when few cells are available. The
harmonized series is anchored on MODIS; VIIRS is divided by the factor when it is
the only sensor. See `docs/PIPELINE.md` for formulas and caveats.

## Notes

- Default regions are the six Brazilian biomes from `config/regions.json`.
- SNPP is excluded from default NRT sources after its 2026 data cessation; use
  NOAA-20/NOAA-21. Historical SNPP rows can still be processed from archives.
- The Nest API in `src/` reads the generated `data/real` dataset.
