#!/usr/bin/env python3
"""Build the compact, harmonized global calendar aggregate from FIRMS CSVs.

The API/painel only needs, for the calendar:
  * cell x year x month x sensor counts;
  * harmonized counts (MODIS + VIIRS / factor);
  * calibration factors per cell/month;
  * a capped sample of recent points for the map/globe;
  * grid cell metadata.

This script reads the raw country/source/year CSVs with DuckDB (columnar,
streaming, no row-by-row SQLite import) and writes those tables to a small
SQLite database (default: /data/db/aggregates.sqlite).

Example:
  docker run --rm \
    -v carcara-orbit_api_data:/data \
    -v /root/dev/carcara-orbit/api/scripts:/scripts:ro \
    python:3.12-slim \
    sh -c 'pip install --quiet duckdb && python /scripts/global_aggregate.py \
      --raw /data/raw/global \
      --regions /data/runtime/global-regions.json \
      --out /data/db/aggregates.sqlite'

Use --max-files 20 for a quick pilot; omit it for the full load.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

import duckdb

MONTHS = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
    "Jul", "Ago", "Set", "Out", "Nov", "Dez",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", default="/data/raw/global")
    parser.add_argument("--regions", default="/data/runtime/global-regions.json")
    parser.add_argument("--out", default="/data/db/aggregates.sqlite")
    parser.add_argument("--tmp", default="/data/db/duckdb-tmp")
    parser.add_argument("--grid", type=float, default=10.0)
    parser.add_argument("--max-files", type=int, default=0)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--memory-limit", default="6GB")
    parser.add_argument("--points-per-cell", type=int, default=50)
    parser.add_argument("--recent-from-year", type=int, default=2024)
    parser.add_argument("--calibration-start", type=int, default=2012)
    parser.add_argument("--calibration-end", type=int, default=2025)
    parser.add_argument("--shrinkage-k", type=float, default=20.0)
    parser.add_argument("--min-factor", type=float, default=0.5)
    parser.add_argument("--max-factor", type=float, default=4.0)
    parser.add_argument("--min-cells-high", type=int, default=8)
    parser.add_argument("--min-cells-medium", type=int, default=6)
    parser.add_argument("--min-modis-confidence", type=int, default=30)
    parser.add_argument("--method-version", default="h1.0")
    return parser.parse_args()


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] {message}", flush=True)


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> int:
    args = parse_args()
    start = time.time()

    files = sorted(glob.glob(os.path.join(args.raw, "*", "*", "*.csv")))
    if args.max_files and args.max_files > 0:
        files = files[: args.max_files]
    if not files:
        log(f"Nenhum CSV encontrado em {args.raw}/*/*/*.csv")
        return 1

    total_bytes = 0
    for path in files:
        try:
            total_bytes += os.path.getsize(path)
        except OSError:
            pass
    log(
        f"{len(files)} arquivos · {total_bytes / (1024 ** 3):.2f} GiB · "
        f"grid {args.grid:g}° · destino {args.out}"
    )

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    os.makedirs(args.tmp, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET threads = {max(1, args.threads)};")
    con.execute(f"SET memory_limit = {sql_quote(args.memory_limit)};")
    con.execute(f"SET temp_directory = {sql_quote(args.tmp)};")
    con.execute("SET preserve_insertion_order = false;")

    modis_files = [
        path
        for path in files
        if os.path.basename(os.path.dirname(path)).startswith("MODIS")
    ]
    viirs_files = [
        path
        for path in files
        if not os.path.basename(os.path.dirname(path)).startswith("MODIS")
    ]
    log(f"{len(modis_files)} arquivos MODIS · {len(viirs_files)} arquivos VIIRS")

    def read_family(paths: list[str], brightness_column: str, sensor: str) -> str:
        listing = "[" + ", ".join(sql_quote(path) for path in paths) + "]"
        return f"""
        SELECT
          TRY_CAST(latitude AS DOUBLE) AS lat,
          TRY_CAST(longitude AS DOUBLE) AS lon,
          CAST(acq_date AS VARCHAR) AS acq_date,
          TRY_CAST(acq_time AS INTEGER) AS acq_time,
          lower(trim(CAST(confidence AS VARCHAR))) AS confidence_raw,
          TRY_CAST(frp AS DOUBLE) AS frp_mw,
          TRY_CAST({brightness_column} AS DOUBLE) AS brightness_k,
          CAST(satellite AS VARCHAR) AS satellite,
          CAST(instrument AS VARCHAR) AS instrument,
          lower(trim(CAST(daynight AS VARCHAR))) AS daynight_raw,
          trim(CAST(type AS VARCHAR)) AS type_raw,
          regexp_extract(filename, '/([^/]+)/[^/]+$', 1) AS source,
          filename,
          '{sensor}' AS sensor
        FROM read_csv(
          {listing},
          header = true,
          union_by_name = true,
          filename = true,
          all_varchar = true
        )
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND acq_date IS NOT NULL
        """

    parts: list[str] = []
    if modis_files:
        parts.append(read_family(modis_files, "brightness", "MODIS"))
    if viirs_files:
        parts.append(read_family(viirs_files, "bright_ti4", "VIIRS"))
    log("Lendo CSVs com DuckDB (streaming, colunar)...")
    con.execute(
        "CREATE OR REPLACE TEMP VIEW raw AS " + " UNION ALL ".join(parts)
    )

    log("Normalizando e filtrando (MODIS/VIIRS, confiança, tipo)...")
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW filtered AS
        SELECT
          'g_'
          || CASE
               WHEN lat_band = 0 THEN '0'
               WHEN lat_band < 0 THEN 's' || CAST(-lat_band AS VARCHAR)
               ELSE 'n' || CAST(lat_band AS VARCHAR)
             END
          || '_'
          || CASE
               WHEN lon_band = 0 THEN '0'
               WHEN lon_band < 0 THEN 'w' || CAST(-lon_band AS VARCHAR)
               ELSE 'e' || CAST(lon_band AS VARCHAR)
             END AS cell_id,
          *,
          CASE
            WHEN source LIKE 'MODIS%' THEN
              CASE
                WHEN TRY_CAST(confidence_raw AS INTEGER) >= 80 THEN 'high'
                WHEN TRY_CAST(confidence_raw AS INTEGER) >= 30 THEN 'nominal'
                ELSE 'low'
              END
            ELSE
              CASE
                WHEN confidence_raw IN ('h', 'high') THEN 'high'
                WHEN confidence_raw IN ('n', 'nominal', 'm', 'medium') THEN 'nominal'
                ELSE 'low'
              END
          END AS confidence_class,
          CASE
            WHEN source LIKE 'MODIS%' THEN TRY_CAST(confidence_raw AS INTEGER)
            WHEN confidence_raw IN ('h', 'high') THEN 90
            WHEN confidence_raw IN ('n', 'nominal', 'm', 'medium') THEN 60
            ELSE 20
          END AS confidence_score,
          CASE
            WHEN type_raw = '1' THEN 'vulcao'
            WHEN type_raw = '2' THEN 'outro'
            WHEN type_raw = '3' THEN 'offshore'
            ELSE 'ok'
          END AS qa_flag,
          CASE lower(satellite)
            WHEN 't' THEN 'Terra' WHEN 'terra' THEN 'Terra'
            WHEN 'a' THEN 'Aqua' WHEN 'aqua' THEN 'Aqua'
            WHEN 'n' THEN 'SNPP' WHEN 'npp' THEN 'SNPP' WHEN 'snpp' THEN 'SNPP'
            WHEN '1' THEN 'NOAA-20' WHEN 'j1' THEN 'NOAA-20'
            WHEN 'noaa-20' THEN 'NOAA-20' WHEN 'noaa20' THEN 'NOAA-20' WHEN 'n20' THEN 'NOAA-20'
            WHEN '2' THEN 'NOAA-21' WHEN 'j2' THEN 'NOAA-21'
            WHEN 'noaa-21' THEN 'NOAA-21' WHEN 'noaa21' THEN 'NOAA-21' WHEN 'n21' THEN 'NOAA-21'
            ELSE satellite
          END AS platform,
          CASE WHEN source LIKE 'MODIS%' THEN 1000 ELSE 375 END AS resolution_m,
          UPPER(daynight_raw) AS daynight,
          {sql_quote(args.method_version)} AS method_version,
          current_timestamp AS imported_at
        FROM (
          SELECT
            *,
            CAST(
              floor((LEAST(89.999999, GREATEST(-89.999999, lat)) + 90) / {args.grid})
              * {args.grid} - 90
              AS INTEGER
            ) AS lat_band,
            CAST(
              floor((LEAST(179.999999, GREATEST(-179.999999, lon)) + 180) / {args.grid})
              * {args.grid} - 180
              AS INTEGER
            ) AS lon_band,
            CAST(TRY_STRPTIME(acq_date, '%Y-%m-%d') AS DATE) AS acq_dt,
            CAST(year(TRY_STRPTIME(acq_date, '%Y-%m-%d')) AS INTEGER) AS year,
            CAST(month(TRY_STRPTIME(acq_date, '%Y-%m-%d')) AS INTEGER) AS month,
            epoch_ms(
              CAST(TRY_STRPTIME(acq_date, '%Y-%m-%d') AS TIMESTAMP)
              + INTERVAL (COALESCE(acq_time, 0) // 100) HOUR
              + INTERVAL (COALESCE(acq_time, 0) % 100) MINUTE
            ) AS ts_ms
          FROM raw
        ) t
        WHERE year IS NOT NULL
        AND (
          (source LIKE 'MODIS%' AND TRY_CAST(confidence_raw AS INTEGER) >= {args.min_modis_confidence})
          OR (
            source NOT LIKE 'MODIS%'
            AND confidence_raw IN ('n', 'nominal', 'm', 'medium', 'h', 'high')
          )
        )
        AND (type_raw IS NULL OR type_raw = '' OR type_raw = '0')
        """
    )

    # Expõe só as colunas normalizadas; a ordem abaixo é a usada pelos
    # agregados e pela amostra de pontos recentes.
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW filtered_clean AS
        SELECT
          cell_id, lat, lon, acq_date, year, month, ts_ms,
          sensor, platform, instrument, resolution_m,
          confidence_score AS confidence, confidence_class,
          brightness_k, frp_mw, daynight, qa_flag, source, method_version, imported_at
        FROM filtered
        """
    )

    log("Agregando célula x ano x mês x sensor...")
    con.execute(
        """
        CREATE OR REPLACE TABLE cell_month AS
        SELECT
          cell_id,
          year,
          month,
          CAST(SUM(CASE WHEN sensor = 'MODIS' THEN 1 ELSE 0 END) AS INTEGER) AS modis,
          CAST(SUM(CASE WHEN sensor = 'VIIRS' THEN 1 ELSE 0 END) AS INTEGER) AS viirs,
          CAST(COUNT(*) AS INTEGER) AS hotspots
        FROM filtered_clean
        GROUP BY 1, 2, 3
        """
    )

    log("Calculando fatores de calibração VIIRS/MODIS por célula/mês...")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE ratios AS
        SELECT
          cell_id,
          month,
          year,
          CAST(viirs AS DOUBLE) / modis AS ratio
        FROM cell_month
        WHERE year BETWEEN {args.calibration_start} AND {args.calibration_end}
          AND modis > 0
          AND viirs > 0;
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE cell_month_stats AS
        SELECT cell_id, month, median(ratio) AS raw_median, COUNT(*) AS cells
        FROM ratios
        GROUP BY 1, 2;
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE cell_factor AS
        SELECT cell_id, median(ratio) AS factor, COUNT(*) AS cells
        FROM ratios
        GROUP BY 1;
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE calibration AS
        SELECT
          s.cell_id,
          s.month,
          LEAST(GREATEST(
            (s.cells / (s.cells + {args.shrinkage_k})) * s.raw_median
            + (1 - s.cells / (s.cells + {args.shrinkage_k})) * COALESCE(f.factor, 1.0),
            {args.min_factor}
          ), {args.max_factor}) AS factor,
          s.raw_median,
          s.cells,
          f.factor AS region_factor,
          CASE
            WHEN s.cells >= {args.min_cells_high} THEN 'high'
            WHEN s.cells >= {args.min_cells_medium} THEN 'medium'
            ELSE 'low'
          END AS confidence
        FROM cell_month_stats s
        LEFT JOIN cell_factor f USING (cell_id);
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE cell_month_harmonized AS
        SELECT
          cm.cell_id,
          cm.year,
          cm.month,
          cm.modis,
          cm.viirs,
          cm.hotspots,
          COALESCE(c.factor, 1.0) AS factor,
          CAST(ROUND(
            cm.modis + cm.viirs / COALESCE(NULLIF(c.factor, 0), 1.0)
          ) AS INTEGER) AS harmonized
        FROM cell_month cm
        LEFT JOIN calibration c USING (cell_id, month);
        """
    )

    log(f"Selecionando amostra de pontos recentes (>= {args.recent_from_year})...")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE recent_points AS
        SELECT *
        FROM (
          SELECT
            sensor || '-' || substr(md5(concat_ws(
              '|', sensor, CAST(ts_ms AS VARCHAR), CAST(lat AS VARCHAR),
              CAST(lon AS VARCHAR), platform, CAST(frp_mw AS VARCHAR),
              CAST(brightness_k AS VARCHAR)
            )), 1, 16) AS id,
            cell_id,
            lat,
            lon,
            acq_date AS date,
            ts_ms,
            year,
            month,
            sensor,
            platform,
            instrument,
            resolution_m,
            confidence,
            confidence_class,
            brightness_k,
            frp_mw,
            daynight,
            qa_flag,
            source,
            method_version,
            ROW_NUMBER() OVER (PARTITION BY cell_id ORDER BY ts_ms DESC) AS rn
          FROM filtered_clean
          WHERE year >= {args.recent_from_year}
        )
        WHERE rn <= {args.points_per_cell};
        """
    )

    log("Lendo a grade global...")
    with open(args.regions, "r", encoding="utf-8") as handle:
        regions_doc = json.load(handle)
    regions = regions_doc.get("regions", [])
    if not regions:
        log(f"Nenhuma região em {args.regions}")
        return 1

    log("Gravando SQLite agregado...")
    # Grava em um arquivo temporário e troca atomicamente: a API pode estar
    # lendo o agregado antigo enquanto o novo é gerado.
    out_tmp = f"{args.out}.tmp"
    for suffix in ("", "-wal", "-shm"):
        stale = out_tmp + suffix
        if os.path.exists(stale):
            os.remove(stale)
    db = sqlite3.connect(out_tmp)
    try:
        db.executescript(
            """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE cells (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              short TEXT,
              biome TEXT,
              scope TEXT,
              area_km2 REAL,
              center TEXT,
              color TEXT,
              polygon TEXT,
              bounds TEXT
            );
            CREATE TABLE cell_month (
              cell_id TEXT NOT NULL,
              year INTEGER NOT NULL,
              month INTEGER NOT NULL,
              modis INTEGER NOT NULL,
              viirs INTEGER NOT NULL,
              hotspots INTEGER NOT NULL,
              factor REAL NOT NULL,
              harmonized INTEGER NOT NULL,
              PRIMARY KEY (cell_id, year, month)
            );
            CREATE TABLE calibration (
              cell_id TEXT NOT NULL,
              month INTEGER NOT NULL,
              factor REAL NOT NULL,
              raw_median REAL,
              cells INTEGER NOT NULL,
              region_factor REAL,
              confidence TEXT NOT NULL,
              PRIMARY KEY (cell_id, month)
            );
            CREATE TABLE recent_points (
              id TEXT PRIMARY KEY,
              cell_id TEXT NOT NULL,
              lat REAL NOT NULL,
              lon REAL NOT NULL,
              date TEXT NOT NULL,
              ts_ms INTEGER NOT NULL,
              year INTEGER NOT NULL,
              month INTEGER NOT NULL,
              sensor TEXT NOT NULL,
              platform TEXT,
              instrument TEXT,
              resolution_m INTEGER,
              confidence INTEGER,
              confidence_class TEXT,
              brightness_k REAL,
              frp_mw REAL,
              daynight TEXT,
              qa_flag TEXT,
              source TEXT,
              method_version TEXT
            );
            CREATE TABLE meta (
              key TEXT PRIMARY KEY,
              value TEXT
            );
            CREATE INDEX idx_cell_month_year ON cell_month(year, month);
            CREATE INDEX idx_recent_points_cell_ts ON recent_points(cell_id, ts_ms);
            CREATE INDEX idx_calibration_cell ON calibration(cell_id);
            """
        )

        cells = []
        for region in regions:
            cells.append(
                (
                    region.get("id"),
                    region.get("name") or region.get("id"),
                    region.get("short"),
                    region.get("biome"),
                    region.get("scope"),
                    region.get("area_km2"),
                    json.dumps(region.get("center"), ensure_ascii=False) if region.get("center") is not None else None,
                    region.get("color"),
                    json.dumps(region.get("polygon"), ensure_ascii=False) if region.get("polygon") is not None else None,
                    json.dumps(region.get("bounds"), ensure_ascii=False) if region.get("bounds") is not None else None,
                )
            )
        db.executemany(
            "INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", cells
        )

        cell_month = con.execute(
            """
            SELECT cell_id, year, month, modis, viirs, hotspots, factor, harmonized
            FROM cell_month_harmonized
            """
        ).fetchall()
        db.executemany(
            "INSERT INTO cell_month VALUES (?, ?, ?, ?, ?, ?, ?, ?)", cell_month
        )

        calibration = con.execute(
            """
            SELECT cell_id, month, factor, raw_median, cells, region_factor, confidence
            FROM calibration
            """
        ).fetchall()
        db.executemany(
            "INSERT INTO calibration VALUES (?, ?, ?, ?, ?, ?, ?)", calibration
        )

        points = con.execute(
            """
            SELECT id, cell_id, lat, lon, date, ts_ms, year, month, sensor, platform,
                   instrument, resolution_m, confidence, confidence_class,
                   brightness_k, frp_mw, daynight, qa_flag, source, method_version
            FROM recent_points
            """
        ).fetchall()
        db.executemany(
            "INSERT OR IGNORE INTO recent_points VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            points,
        )

        years = con.execute(
            "SELECT MIN(year), MAX(year) FROM cell_month_harmonized"
        ).fetchone()
        totals = con.execute(
            "SELECT COUNT(*), COALESCE(SUM(hotspots), 0), COUNT(DISTINCT cell_id) FROM cell_month"
        ).fetchone()
        now = datetime.now(timezone.utc).isoformat()
        meta = {
            "generated_at": now,
            "grid_degrees": str(args.grid),
            "years_min": str(years[0]) if years and years[0] is not None else "",
            "years_max": str(years[1]) if years and years[1] is not None else "",
            "months": ",".join(MONTHS),
            "method_version": args.method_version,
            "calibration_window": f"{args.calibration_start}-{args.calibration_end}",
            "source": "NASA FIRMS / Earthdata",
            "source_files": str(len(files)),
            "source_bytes": str(total_bytes),
            "hotspots": str(totals[1]),
            "cells_with_data": str(totals[2]),
            "filters": (
                f"type=0; MODIS confidence>={args.min_modis_confidence}; "
                "VIIRS confidence in (nominal, high)"
            ),
            "disclaimer": (
                "Contagens globais derivadas de focos ativos NASA FIRMS/Earthdata. "
                "Uso informativo; não substitui validação oficial."
            ),
        }
        db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
        db.commit()
        db.execute("ANALYZE")
        db.commit()
    finally:
        db.close()

    for suffix in ("-wal", "-shm"):
        stale = out_tmp + suffix
        if os.path.exists(stale):
            os.remove(stale)
    os.replace(out_tmp, args.out)
    for suffix in ("-wal", "-shm"):
        stale = args.out + suffix
        if os.path.exists(stale):
            try:
                os.remove(stale)
            except OSError:
                pass

    elapsed = time.time() - start
    log(
        f"Pronto: {totals[0]} linhas célula/mês · {totals[1]} focos · "
        f"{totals[2]} células · {len(points)} pontos recentes · "
        f"{os.path.getsize(args.out) / (1024 ** 2):.1f} MiB · {elapsed:.1f}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
