# Harmonization pipeline

This document describes the data pipeline implemented in `src/pipeline/`.

## 1. Inputs

The pipeline accepts FIRMS Active Fire CSV files. It detects the sensor from the
header:

- MODIS: `brightness`, numeric `confidence`, platforms Terra/Aqua;
- VIIRS: `bright_ti4`/`bright_ti5`, `low|nominal|high` confidence, platforms
  SNPP/NOAA-20/NOAA-21.

Supported columns include:

```text
latitude, longitude, brightness|bright_ti4, scan, track, acq_date, acq_time,
satellite, instrument, confidence, version, bright_t31|bright_ti5, frp,
daynight, type
```

The archive filename can also identify the sensor (`modis`, `viirs`, `noaa20`,
`noaa21`). Explicit source metadata from `config/sources.json` is used for NRT.

## 2. Normalization

Each row becomes:

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

Confidence normalization:

| Sensor | Input | Score | Class |
|---|---|---:|---|
| MODIS | 0–100 | value | `<30` low, `30–79` nominal, `≥80` high |
| VIIRS | `low` | 20 | `baixa` |
| VIIRS | `nominal` | 60 | `nominal` |
| VIIRS | `high` | 90 | `alta` |

Filters:

- MODIS rows below `MODIS_MIN_CONFIDENCE` (default 30) are dropped.
- VIIRS rows below `VIIRS_MIN_CLASS` (default `nominal`) are dropped.
- Rows outside configured region polygons are dropped when regions are provided.
- Invalid coordinates/dates/times are dropped.

FIRMS Active Fire CSV does not contain a cloud mask. `qa_flag` is derived from
the `type` field (`0` → `ok`, `1` → `volcano`, `2` → `other`, `3` → `offshore`).
Cloud/edge filtering requires a different product and is not implemented here.

## 3. Spatiotemporal clustering

The same fire can be detected by Terra/Aqua or by multiple VIIRS platforms.
Clusters merge detections when:

- distance ≤ **1 km** (haversine);
- time since the cluster's first detection ≤ **3 h** (cluster duration).

The cluster centroid is the running mean of its hotspots. A cluster exposes:

- `sensors`: unique sensors in the cluster (`MODIS`, `VIIRS`, or both);
- `platforms`: unique platforms;
- `hotspot_count`;
- a representative hotspot with the highest confidence.

Clustering uses a 0.01° spatial hash and a 3×3 neighbor lookup.

## 4. Grid

Clusters are assigned to 0.1° cells:

```text
cell_id = round(lon / 0.1) + "_" + round(lat / 0.1)
```

The unit of count is the **cluster**, not the pixel.

## 5. Calibration

Window: `CALIBRATION_START_YEAR`–`CALIBRATION_END_YEAR` (default 2012–2025).
Calibration uses daytime clusters when there are enough; otherwise it falls back
to all clusters.

For each region and month:

```text
ratio[cell] = N_VIIRS[cell, month] / N_MODIS[cell, month]
raw_factor  = median(ratio[cell])
```

Only cells with both counts > 0 are used. The factor is shrunk toward the region
factor when the number of cells is small:

```text
w = n_cells / (n_cells + k)          # k = CALIBRATION_SHRINKAGE_K (default 20)
factor = w * raw_factor + (1 - w) * region_factor
factor = clamp(factor, 0.5, 4.0)
```

Uncertainty is estimated with a deterministic bootstrap of the median
(200 resamples; 95% interval). Confidence:

- `alta`: at least `CALIBRATION_MIN_CELLS` and uncertainty ≤ 20%;
- `média`: at least `CALIBRATION_MIN_CELLS`;
- `baixa`: fewer cells or no overlap.

If there is no overlap at all, the factor falls back to `1.0` and a warning is
written to the metadata.

## 6. Harmonization

The series is anchored on MODIS:

```text
if MODIS count > 0:  harmonized = MODIS count
else if VIIRS > 0:   harmonized = round(VIIRS count / factor[region, month])
else:                harmonized = 0
```

MODIS and VIIRS are never added together for the same month. A cluster that
contains both sensors contributes to the MODIS raw count and is used as the
MODIS anchor.

## 7. Anomaly and baseline

Baseline: `BASELINE_START_YEAR`–`BASELINE_END_YEAR` (default 2003–2025).

For each month:

```text
anomaly_pct = (value - mean_same_month_baseline) / mean_same_month_baseline * 100
```

- Months without a baseline mean or without a value are `null`.
- The current year is partial; its anomaly compares the same months that exist
  in the current year against the same-month baseline means.
- The trend is a linear regression over complete baseline annual totals, expressed
  as % of the mean per decade.
- The historical peak uses complete baseline years only.
- The critical season is the set of months with a climatological mean ≥ 50% of
  the peak monthly mean.

## 8. Outputs

`data/real/`:

| File | Content |
|---|---|
| `calendario.json` | Matrix, series, metrics, insights, metadata |
| `hotspots.geojson` | All clusters in the selected region(s) |
| `pontos-recentes.json` | Map sample limited by `MAX_MAP_POINTS` |
| `run-meta.json` | Input counts, clusters, calibration summary, warnings |
| `raw/hotspots.jsonl` | Normalized hotspots for future NRT merges |

`calendario.json` follows the research-base schema:

- `meta`, `months`, `years`, `baseline_years`, `regions`;
- `calendar[region]`: `counts`, `anomaly_pct`, `raw_modis`, `raw_viirs`,
  `viirs_share_pct`;
- `series[region]`: `annual`, `climatology`, `season`;
- `metrics[region]`;
- `insights[region]`.

## 9. Real data workflow

Bootstrap the SQLite database (scrapes the public FIRMS yearly country CSVs,
imports them into `data/db/firms.sqlite`, fetches only the current NRT window
through the API, then rebuilds `data/real`):

```bash
npm run bootstrap
```

Historical CSVs stay in `data/raw/country/`. The import is resumable through
`data/runtime/import.json`. `data/db/firms.sqlite` is the historical source of
truth; `hotspots.geojson` exports only the recent window
(`HOTSPOTS_EXPORT_MONTHS`, default 24).

Legacy historical backfill through the FIRMS Area API (`*_SP` sources):

```bash
npm run backfill -- --start 2000-11-01 --end 2026-10-31 \
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP \
  --bbox=-74,-34,-34,6
```

The backfill uses 5-day chunks (the API maximum), checkpoints in
`data/runtime/backfill.json`, and writes one CSV per chunk under
`data/raw/<source>/`. Re-running resumes and skips completed chunks. Source
coverage:

| Source | Period |
|---|---|
| `MODIS_SP` | 2000-11-01 onward |
| `VIIRS_SNPP_SP` | 2012-01-20 to 2026-11-02 |
| `VIIRS_NOAA20_SP` | 2018-04-01 onward |
| `VIIRS_NOAA21_SP` | 2023-03-01 onward |

The FIRMS API is limited to 5 days per request and 5,000 transactions per
10-minute window. Five-day requests may count as multiple transactions.
For a smaller area use `--region pantanal` or `--bbox=...`; the full Brazil
4-source plan has ~3,900 chunks and can consume significant disk/time.

After the backfill:

1. Run `node pipeline/src/cli.js pipeline --input data/raw --out data/real`.
2. Switch the API to real mode.

Manual archive import:

1. Download FIRMS MODIS/VIIRS archive CSVs for the area and period.
2. Put them under `data/raw/` (subdirectories allowed).
3. Run `node pipeline/src/cli.js pipeline --input data/raw --out data/real`.
4. Switch the API to real mode.

NRT:

1. Set `FIRMS_MAP_KEY` and `NRT_ENABLED=true`.
2. The scheduler fetches the last `NRT_DAYS` for each configured region/source.
3. New normalized hotspots are merged into `raw/hotspots.jsonl`.
4. The full stored history is re-clustered and the real dataset is rebuilt.
5. On failure, the previous real dataset is kept.

## 10. Caveats

- No burned-area estimation; hotspot counts are a proxy for activity.
- No cloud mask or land-cover mask in the Active Fire CSV.
- Calibration factors are only as good as the overlap data; validate with a fire
  scientist before operational use.
- Default regions are six Brazilian biomes. Add polygons to
  `config/regions.json` for other AOIs.
- Global/long histories should use a database or tile-based batch pipeline rather
  than re-clustering the full JSONL on every NRT refresh.
- `data/real/raw/hotspots.jsonl` is the historical source of truth for NRT.
  Deleting it means the next NRT run can only rebuild from the days it fetched.
- Suomi NPP is excluded from default NRT sources after its 2026 data cessation;
  use NOAA-20/NOAA-21.
