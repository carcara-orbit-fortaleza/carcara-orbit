#!/usr/bin/env python3
"""Fetch the current year of FIRMS active fires through the Area API.

The yearly country CSVs used by the historical aggregate only exist after a
year is closed. This job fills the gap for the current year:

* reads the FIRMS data availability CSV to split each sensor family between its
  standard-processing (SP) and near-real-time (NRT) sources;
* downloads 5-day world chunks into ``<out>/<source>/<start>_<end>.csv``;
* the DuckDB aggregate reads ``raw/global/current/<source>/*.csv`` as an overlay
  on top of the historical country files.

Example (inside a Python container with the API volume mounted):

  docker run --rm --ulimit nofile=65536:65536 \
    -v carcara-orbit_api_data:/data \
    -v "$PWD/api/scripts:/scripts:ro" \
    -e FIRMS_MAP_KEY="$FIRMS_MAP_KEY" \
    python:3.12-slim \
    python /scripts/fetch_current_year.py --year 2026

Use ``--dry-run`` to list the ranges, or ``--max-chunks 4`` for a pilot.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

AREA_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
AVAILABILITY_BASE = (
    "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv"
)

# Each family switches from standard processing to NRT when the archive for the
# year catches up with the present.
FAMILIES = (
    ("MODIS_SP", "MODIS_NRT"),
    ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
    ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=datetime.now(timezone.utc).year)
    parser.add_argument("--out", default="/data/raw/global/current")
    parser.add_argument("--map-key", default=os.environ.get("FIRMS_MAP_KEY", ""))
    parser.add_argument("--chunk-days", type=int, default=5)
    parser.add_argument("--delay", type=float, default=12.0)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--cooldown", type=float, default=600.0)
    parser.add_argument("--max-rate-waits", type=int, default=12)
    parser.add_argument("--max-chunks", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] {message}", flush=True)


def fetch(url: str, timeout: float) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "carcara-orbit/1.0 (+global current-year job)"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, "replace")


def load_availability(map_key: str, timeout: float) -> dict[str, tuple[date, date]]:
    url = f"{AVAILABILITY_BASE}/{urllib.parse.quote(map_key)}/all"
    text = fetch(url, timeout)
    rows: dict[str, tuple[date, date]] = {}
    for line in text.splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 3:
            continue
        source, min_date, max_date = parts[0].strip(), parts[1], parts[2]
        try:
            rows[source] = (date.fromisoformat(min_date), date.fromisoformat(max_date))
        except ValueError:
            continue
    return rows


def build_ranges(
    year: int, availability: dict[str, tuple[date, date]]
) -> list[tuple[str, date, date]]:
    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    today = datetime.now(timezone.utc).date()
    target_end = min(year_end, today)
    ranges: list[tuple[str, date, date]] = []
    for sp_source, nrt_source in FAMILIES:
        sp_window = availability.get(sp_source)
        nrt_window = availability.get(nrt_source)
        if sp_window is not None:
            start = max(year_start, sp_window[0])
            end = min(target_end, sp_window[1])
            if start <= end:
                ranges.append((sp_source, start, end))
        if nrt_window is not None:
            # NRT can cover the whole year for newer satellites. Keep it only
            # after the standard-processing archive to avoid double counting.
            after_sp = (
                sp_window[1] + timedelta(days=1) if sp_window else year_start
            )
            start = max(year_start, nrt_window[0], after_sp)
            end = min(target_end, nrt_window[1])
            if start <= end:
                ranges.append((nrt_source, start, end))
    return ranges


def write_atomic(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(temporary, path)


def main() -> int:
    args = parse_args()
    if not args.map_key:
        log("FIRMS_MAP_KEY is required (--map-key or environment).")
        return 1
    if args.chunk_days < 1 or args.chunk_days > 5:
        log("--chunk-days must be between 1 and 5 (FIRMS Area API limit).")
        return 1

    log(f"Reading FIRMS availability for {args.year}...")
    try:
        availability = load_availability(args.map_key, args.timeout)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        log(f"Could not read FIRMS availability: {error}")
        return 1

    ranges = build_ranges(args.year, availability)
    if not ranges:
        log(f"No FIRMS sources with data for {args.year}.")
        return 1
    log(f"{len(ranges)} source ranges for {args.year}:")
    for source, start, end in ranges:
        log(f"  {source}: {start} .. {end}")

    if args.dry_run:
        return 0

    attempted = 0
    downloaded = 0
    skipped = 0
    empty = 0
    rate_waits = 0
    failed: list[str] = []

    for source, start, end in ranges:
        cursor = start
        while cursor <= end:
            if args.max_chunks and attempted >= args.max_chunks:
                log(f"Stopping at --max-chunks {args.max_chunks}.")
                return 0
            chunk_end = min(cursor + timedelta(days=args.chunk_days - 1), end)
            days = (chunk_end - cursor).days + 1
            chunk_start = cursor
            name = f"{chunk_start.isoformat()}_{chunk_end.isoformat()}.csv"
            path = os.path.join(args.out, source, name)
            cursor = chunk_end + timedelta(days=1)
            if not args.force and os.path.exists(path) and os.path.getsize(path) > 0:
                skipped += 1
                continue

            attempted += 1
            url = (
                f"{AREA_BASE}/{urllib.parse.quote(args.map_key)}/{source}"
                f"/world/{days}/{chunk_start.isoformat()}"
            )
            text = ""
            attempt = 1
            while attempt <= args.retries:
                try:
                    text = fetch(url, args.timeout)
                    first = text.strip().splitlines()[0].lower() if text.strip() else ""
                    if not first.startswith("latitude,longitude"):
                        raise RuntimeError(f"unexpected response: {first[:120]}")
                    break
                except urllib.error.HTTPError as error:
                    body = error.read().decode("utf-8", "replace")
                    if "transaction limit" in body.lower():
                        rate_waits += 1
                        if rate_waits > args.max_rate_waits:
                            failed.append(
                                f"{source} {name}: rate limit after "
                                f"{args.max_rate_waits} waits"
                            )
                            log(f"FAILED {source} {name}: rate limit")
                            text = ""
                            break
                        log(
                            f"rate limit ({rate_waits}/{args.max_rate_waits}); "
                            f"sleeping {int(args.cooldown)}s"
                        )
                        time.sleep(args.cooldown)
                        continue
                    if attempt >= args.retries:
                        failed.append(f"{source} {name}: HTTP {error.code} {body[:120]}")
                        log(f"FAILED {source} {name}: HTTP {error.code}")
                        text = ""
                        break
                    time.sleep(2 * attempt)
                    attempt += 1
                except (
                    urllib.error.URLError,
                    TimeoutError,
                    OSError,
                    RuntimeError,
                ) as error:
                    if attempt >= args.retries:
                        failed.append(f"{source} {name}: {error}")
                        log(f"FAILED {source} {name}: {error}")
                        text = ""
                        break
                    time.sleep(2 * attempt)
                    attempt += 1

            if not text:
                continue

            rows = max(0, len(text.strip().splitlines()) - 1)
            if rows == 0:
                empty += 1
                log(f"empty  {source} {name}")
            else:
                write_atomic(path, text)
                downloaded += 1
                log(f"ok     {source} {name} ({rows} rows)")
            time.sleep(max(0.0, args.delay))

    log(
        f"Done: {downloaded} files, {skipped} skipped, {empty} empty, "
        f"{len(failed)} failed, {attempted} requests."
    )
    if failed:
        for item in failed:
            log(f"  {item}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
