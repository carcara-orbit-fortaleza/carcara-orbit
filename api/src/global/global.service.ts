import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  FIRST_YEAR,
  LAST_YEAR,
  parseBbox,
  parseSensor,
  parseYearRange,
} from '../common/query.js';
import { globalPaths } from './global.paths.js';

const MONTHS = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
];

const REGION_LIMIT = 200;
const REGION_MAX_LIMIT = 2000;
const HOTSPOT_LIMIT = 5000;
const HOTSPOT_MAX_LIMIT = 50000;
const FIRMS_AVAILABILITY_URL =
  'https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv';
const FIRMS_YEAR_TTL_MS = 6 * 60 * 60 * 1000;
const FIRMS_YEAR_RETRY_MS = 5 * 60 * 1000;
const SEPARATOR = ';';
const BOM = '﻿';

/**
 * Maior ano com dados entre as fontes MODIS/VIIRS da disponibilidade do FIRMS.
 * A resposta é um CSV `data_id,min_date,max_date`, uma linha por fonte.
 */
export function latestFirmsYear(csv: string): number | null {
  let latest = '';
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [id, , maxDate] = line.split(',');
    if (!id || !maxDate) continue;
    if (!/^(MODIS|VIIRS)_/.test(id)) continue;
    if (maxDate > latest) latest = maxDate;
  }
  const year = Number(latest.slice(0, 4));
  return Number.isInteger(year) && year >= FIRST_YEAR ? year : null;
}

function decimal(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.toFixed(1).replace('.', ',');
}

export interface GlobalRegion {
  id: string;
  name: string;
  short?: string;
  biome: string;
  scope?: string;
  area_km2?: number;
  center?: [number, number];
  color?: string;
  polygon?: [number, number][];
  bounds?: [number, number, number, number];
}

interface GlobalRegionsFile {
  scope: string;
  grid_degrees: number;
  generated_at: string;
  regions: GlobalRegion[];
}

interface GlobalCalibration {
  scope?: string;
  grid_degrees?: number;
  generated_at?: string;
  method_version?: string;
  calibration_window?: string;
  factors: Record<
    string,
    Record<string, { factor: number; confidence?: string; cells?: number }>
  >;
  warnings?: string[];
}

interface GlobalIngestionStatus {
  running?: boolean;
  phase?: string;
  startedAt?: string;
  finishedAt?: string;
  options?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface GlobalDatabaseStats {
  available: boolean;
  path: string;
  hotspots?: number;
  clusters?: number;
  firstYear?: number | null;
  lastYear?: number | null;
  regionsWithData?: number;
  sizeBytes?: number;
  error?: string;
}

interface RegionRow {
  region_id: string;
  hotspots: number;
  first_year: number;
  last_year: number;
}

interface CalendarRow {
  region_id: string;
  year: number;
  month: number;
  modis: number;
  viirs: number;
}

interface HotspotRow {
  id: string;
  lat: number;
  lon: number;
  ts_ms: number;
  year: number;
  month: number;
  region_id: string | null;
  biome: string | null;
  sensors: string | null;
  platforms: string | null;
  hotspot_count: number;
  has_modis: number;
  has_viirs: number;
  confidence: number | null;
  confidence_class: string | null;
  brightness_k: number | null;
  frp_mw: number | null;
  daynight: string | null;
  qa_flag: string | null;
  instrument: string | null;
  resolution_m: number | null;
}

interface AggregateCellRow {
  id: string;
  name: string;
  short: string | null;
  biome: string | null;
  scope: string | null;
  area_km2: number | null;
  center: string | null;
  color: string | null;
  polygon: string | null;
  bounds: string | null;
}

interface AggregateCalendarRow {
  cell_id: string;
  year: number;
  month: number;
  modis: number;
  viirs: number;
  hotspots: number;
  factor: number;
  harmonized: number;
}

interface AggregateCalibrationRow {
  cell_id: string;
  month: number;
  factor: number;
  confidence: string;
}

interface AggregatePointRow {
  id: string;
  cell_id: string;
  lat: number;
  lon: number;
  date: string;
  ts_ms: number;
  year: number;
  month: number;
  sensor: string;
  platform: string | null;
  instrument: string | null;
  resolution_m: number | null;
  confidence: number | null;
  confidence_class: string | null;
  brightness_k: number | null;
  frp_mw: number | null;
  daynight: string | null;
  qa_flag: string | null;
  source: string | null;
  method_version: string | null;
  region_name: string | null;
  region_biome: string | null;
  calibration_factor: number | null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`limit deve ser um inteiro entre 1 e ${max}`);
  }
  return parsed;
}

@Injectable()
export class GlobalService {
  private readonly paths = globalPaths();
  private regionsCache: { mtimeMs: number; data: GlobalRegionsFile } | null = null;
  private calibrationCache: { mtimeMs: number; data: GlobalCalibration } | null =
    null;
  private firmsYearCache: { year: number | null; at: number } | null = null;

  /** Ano corrente segundo a disponibilidade do FIRMS, com cache curto. */
  private async firmsCurrentYear(): Promise<number | null> {
    const now = Date.now();
    const cached = this.firmsYearCache;
    const ttl = cached?.year === null ? FIRMS_YEAR_RETRY_MS : FIRMS_YEAR_TTL_MS;
    if (cached && now - cached.at < ttl) return cached.year;
    const key = process.env.FIRMS_MAP_KEY;
    if (!key) {
      this.firmsYearCache = { year: null, at: now };
      return null;
    }
    try {
      const response = await fetch(
        `${FIRMS_AVAILABILITY_URL}/${encodeURIComponent(key)}/all`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const year = latestFirmsYear(await response.text());
      this.firmsYearCache = { year, at: now };
      return year;
    } catch {
      this.firmsYearCache = { year: null, at: now };
      return null;
    }
  }

  /** Status of the global database, grid and ingestion job. */
  status() {
    const ingestion = this.readStatus();
    const regions = this.loadRegions();
    const calibration = this.loadCalibration();
    return {
      scope: 'global',
      database: this.readDatabaseStats(),
      regions: {
        configured: Boolean(regions),
        count: regions?.regions.length ?? 0,
        gridDegrees: regions?.grid_degrees ?? null,
        generatedAt: regions?.generated_at ?? null,
      },
      calibration: calibration
        ? {
            available: true,
            gridDegrees: calibration.grid_degrees ?? null,
            generatedAt: calibration.generated_at ?? null,
            methodVersion: calibration.method_version ?? null,
            window: calibration.calibration_window ?? null,
            regions: Object.keys(calibration.factors ?? {}).length,
            warnings: calibration.warnings?.length ?? 0,
          }
        : { available: false },
      ingestion,
    };
  }

  /**
   * Compact harmonized calendar aggregate: every grid cell with monthly
   * MODIS/VIIRS/harmonized counts and calibration factors.
   */
  async aggregates() {
    const path = this.paths.aggregatesFile;
    if (!existsSync(path)) {
      throw new ServiceUnavailableException(
        'O agregado global ainda não foi gerado. Rode o job de agregação (DuckDB).',
      );
    }
    const firmsYear = await this.firmsCurrentYear();
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000;');
      const metaRows = db
        .prepare('SELECT key, value FROM meta')
        .all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
      const yearsMin = Number(meta.years_min ?? 2000);
      const dataYearsMax = Number(meta.years_max ?? 2025);
      // O agregado cobre só anos consolidados; o FIRMS informa o ano corrente
      // (NRT), que entra no calendário como coluna ainda sem dados.
      const nowYear = new Date().getUTCFullYear();
      const currentYear = Math.min(
        nowYear,
        LAST_YEAR,
        Math.max(dataYearsMax, firmsYear ?? nowYear),
      );
      const lastYear = Math.max(dataYearsMax, currentYear);
      const years = Array.from(
        { length: Math.max(0, lastYear - yearsMin + 1) },
        (_, index) => yearsMin + index,
      );
      const cellRows = db
        .prepare('SELECT * FROM cells')
        .all() as unknown as AggregateCellRow[];
      const monthRows = db
        .prepare(
          `SELECT cell_id, year, month, modis, viirs, hotspots, factor, harmonized
           FROM cell_month`,
        )
        .all() as unknown as AggregateCalendarRow[];
      const calibrationRows = db
        .prepare(
          'SELECT cell_id, month, factor, confidence FROM calibration',
        )
        .all() as unknown as AggregateCalibrationRow[];

      const makeMatrix = (): (number | null)[][] =>
        years.map(() => Array.from({ length: 12 }, () => null));

      const cells = cellRows.map((row) => ({
        id: row.id,
        name: row.name,
        short: row.short,
        biome: row.biome,
        scope: row.scope,
        areaKm2: row.area_km2,
        center: parseJson<[number, number]>(row.center),
        color: row.color,
        polygon: parseJson<[number, number][]>(row.polygon),
        bounds: parseJson<[number, number, number, number]>(row.bounds),
        hotspots: 0,
        firstYear: null as number | null,
        lastYear: null as number | null,
        counts: makeMatrix(),
        modis: makeMatrix(),
        viirs: makeMatrix(),
        factors: Array.from({ length: 12 }, () => 1),
        calibration: Array.from({ length: 12 }, () => ({
          factor: 1,
          confidence: 'low',
        })),
      }));
      const cellMap = new Map(cells.map((cell) => [cell.id, cell]));

      for (const row of monthRows) {
        const cell = cellMap.get(row.cell_id);
        if (!cell) continue;
        const yearIndex = row.year - yearsMin;
        const monthIndex = row.month - 1;
        if (
          yearIndex < 0 ||
          yearIndex >= years.length ||
          monthIndex < 0 ||
          monthIndex >= 12
        ) {
          continue;
        }
        cell.counts[yearIndex][monthIndex] = Number(row.harmonized) || 0;
        cell.modis[yearIndex][monthIndex] = Number(row.modis) || 0;
        cell.viirs[yearIndex][monthIndex] = Number(row.viirs) || 0;
        cell.factors[monthIndex] = Number(row.factor) || 1;
        cell.hotspots += Number(row.hotspots) || 0;
        cell.firstYear =
          cell.firstYear === null ? row.year : Math.min(cell.firstYear, row.year);
        cell.lastYear =
          cell.lastYear === null ? row.year : Math.max(cell.lastYear, row.year);
      }

      for (const row of calibrationRows) {
        const cell = cellMap.get(row.cell_id);
        if (!cell) continue;
        const monthIndex = row.month - 1;
        if (monthIndex < 0 || monthIndex >= 12) continue;
        cell.calibration[monthIndex] = {
          factor: Number(row.factor) || 1,
          confidence: row.confidence || 'low',
        };
      }

      cells.sort(
        (a, b) => b.hotspots - a.hotspots || a.name.localeCompare(b.name),
      );

      const baselineFrom = Math.max(
        FIRST_YEAR,
        Number(process.env.BASELINE_START_YEAR ?? 2003),
      );
      const baselineTo = Math.min(
        dataYearsMax,
        currentYear - 1,
        Number(process.env.BASELINE_END_YEAR ?? 2025),
      );

      return {
        scope: 'global',
        gridDegrees: Number(meta.grid_degrees ?? 10),
        years,
        months: MONTHS,
        methodVersion: meta.method_version ?? 'h1.0',
        datasetVersion: meta.method_version ?? 'h1.0',
        currentYear,
        baselineFrom,
        baselineTo,
        lastCompleteYear: Math.min(dataYearsMax, currentYear - 1),
        warnings: [],
        calibrationWindow: meta.calibration_window ?? null,
        disclaimer:
          meta.disclaimer ??
          'Contagens globais derivadas de focos ativos NASA FIRMS/Earthdata. Uso informativo; não substitui validação oficial.',
        source: meta.source ?? 'NASA FIRMS / Earthdata',
        cells,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        `Falha ao ler o agregado global: ${errorMessage(error)}`,
      );
    } finally {
      db?.close();
    }
  }

  /** Grid cells that have global hotspots, optionally filtered by bbox. */
  listRegions(params: { bbox?: string; limit?: string } = {}) {
    const limit = parseLimit(params.limit, REGION_LIMIT, REGION_MAX_LIMIT);
    const bbox = parseBbox(params.bbox);
    const regionsFile = this.loadRegions();
    const metadata = new Map(
      (regionsFile?.regions ?? []).map((region) => [region.id, region]),
    );
    const rows = this.query<RegionRow>(
      `SELECT region_id,
              COUNT(*) AS hotspots,
              MIN(year) AS first_year,
              MAX(year) AS last_year
       FROM hotspots
       WHERE region_id IS NOT NULL
       GROUP BY region_id
       ORDER BY hotspots DESC, region_id ASC`,
    );

    const all = rows
      .map((row) => {
        const meta = metadata.get(row.region_id);
        return {
          ...(meta ?? {
            id: row.region_id,
            name: row.region_id,
            biome: 'Grade global',
            color: '#4E79A7',
          }),
          id: row.region_id,
          hotspots: numberOr(row.hotspots),
          firstYear: numberOr(row.first_year),
          lastYear: numberOr(row.last_year),
        };
      })
      .filter((region) => {
        if (!bbox || !region.bounds) return true;
        const [west, south, east, north] = bbox;
        const [rWest, rSouth, rEast, rNorth] = region.bounds;
        return rWest < east && rEast > west && rSouth < north && rNorth > south;
      });

    return {
      scope: 'global',
      gridDegrees: regionsFile?.grid_degrees ?? null,
      total: all.length,
      returned: Math.min(limit, all.length),
      regions: all.slice(0, limit),
    };
  }

  regionsGeoJson(params: { bbox?: string; limit?: string } = {}) {
    const result = this.listRegions(params);
    return {
      type: 'FeatureCollection' as const,
      name: 'global-grid',
      features: result.regions
        .filter((region) => Array.isArray(region.polygon))
        .map((region) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: [region.polygon] },
          properties: {
            id: region.id,
            name: region.name,
            biome: region.biome,
            color: region.color,
            hotspots: region.hotspots,
            first_year: region.firstYear,
            last_year: region.lastYear,
          },
        })),
    };
  }

  /**
   * Monthly calendar for a grid cell or an arbitrary bbox. Counts are
   * harmonized per grid cell with the calibration factors written by ingestion.
   */
  calendar(params: {
    region?: string;
    bbox?: string;
    from?: string;
    to?: string;
  }) {
    const area = this.resolveArea(params);
    const period = parseYearRange(params.from, params.to);
    const calibration = this.loadCalibration();
    const [west, south, east, north] = area.bbox;
    const values: Array<string | number> = [
      period.from,
      period.to,
      south,
      north,
      west,
      east,
    ];
    let regionClause = '';
    if (area.region) {
      regionClause = 'AND region_id = ?';
      values.push(area.region.id);
    }

    const rows = this.query<CalendarRow>(
      `SELECT region_id, year, month,
              SUM(has_modis) AS modis,
              SUM(has_viirs) AS viirs
       FROM clusters
       WHERE year >= ? AND year <= ?
         AND lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?
         AND region_id IS NOT NULL ${regionClause}
       GROUP BY region_id, year, month`,
      values,
    );

    const buckets = new Map<
      string,
      { modis: number; viirs: number; harmonized: number }
    >();
    for (const row of rows) {
      const key = `${numberOr(row.year)}-${numberOr(row.month)}`;
      const bucket = buckets.get(key) ?? { modis: 0, viirs: 0, harmonized: 0 };
      const modis = numberOr(row.modis);
      const viirs = numberOr(row.viirs);
      const factor = this.factorFor(row.region_id, numberOr(row.month));
      bucket.modis += modis;
      bucket.viirs += viirs;
      bucket.harmonized += modis + (factor > 0 ? viirs / factor : viirs);
      buckets.set(key, bucket);
    }

    const years = Array.from(
      { length: period.to - period.from + 1 },
      (_, index) => period.from + index,
    );
    const counts: (number | null)[][] = years.map(() => Array(12).fill(null));
    const rawModis: (number | null)[][] = years.map(() => Array(12).fill(null));
    const rawViirs: (number | null)[][] = years.map(() => Array(12).fill(null));
    const viirsShare: (number | null)[][] = years.map(() => Array(12).fill(null));

    years.forEach((year, yearIndex) => {
      for (let month = 1; month <= 12; month += 1) {
        const value = buckets.get(`${year}-${month}`);
        if (!value) continue;
        counts[yearIndex][month - 1] = Math.round(value.harmonized);
        rawModis[yearIndex][month - 1] = Math.round(value.modis);
        rawViirs[yearIndex][month - 1] = Math.round(value.viirs);
        const total = value.modis + value.viirs;
        viirsShare[yearIndex][month - 1] =
          total > 0 ? round((value.viirs / total) * 100, 1) : null;
      }
    });

    const baselineStart = Math.max(
      FIRST_YEAR,
      numberOr(process.env.BASELINE_START_YEAR, 2003),
    );
    const baselineEnd = Math.min(
      period.to,
      numberOr(process.env.BASELINE_END_YEAR, Math.min(2025, period.to)),
    );
    const monthlyBaseline = MONTHS.map((_, monthIndex) => {
      const valuesByYear: number[] = [];
      years.forEach((year, yearIndex) => {
        if (year < baselineStart || year > baselineEnd) return;
        const value = counts[yearIndex][monthIndex];
        if (value !== null) valuesByYear.push(value);
      });
      if (valuesByYear.length === 0) return null;
      return valuesByYear.reduce((sum, value) => sum + value, 0) / valuesByYear.length;
    });
    const anomaly: (number | null)[][] = counts.map((row) =>
      row.map((value, monthIndex) => {
        const baseline = monthlyBaseline[monthIndex];
        if (value === null || baseline === null || baseline <= 0) return null;
        return round(((value - baseline) / baseline) * 100, 1);
      }),
    );

    const annual = years.map((year, yearIndex) => {
      const row = counts[yearIndex];
      const valuesByMonth = row.filter((value): value is number => value !== null);
      const total = valuesByMonth.length
        ? valuesByMonth.reduce((sum, value) => sum + value, 0)
        : null;
      return {
        year,
        total,
        partial: valuesByMonth.length > 0 && valuesByMonth.length < 12,
      };
    });
    const baselineAnnual = annual
      .filter((entry) => entry.year >= baselineStart && entry.year <= baselineEnd)
      .map((entry) => entry.total)
      .filter((value): value is number => value !== null);
    const baselineMeanAnnual = baselineAnnual.length
      ? baselineAnnual.reduce((sum, value) => sum + value, 0) / baselineAnnual.length
      : null;
    const series = {
      annual: annual.map((entry) => ({
        ...entry,
        baseline_total: baselineMeanAnnual === null ? null : Math.round(baselineMeanAnnual),
        anomaly_pct:
          entry.total !== null && baselineMeanAnnual !== null && baselineMeanAnnual > 0
            ? round(((entry.total - baselineMeanAnnual) / baselineMeanAnnual) * 100, 1)
            : null,
      })),
    };

    const withData = annual.filter((entry) => entry.total !== null);
    const peak = withData.reduce<{ year: number; total: number } | null>(
      (best, entry) =>
        entry.total !== null && (!best || entry.total > best.total)
          ? { year: entry.year, total: entry.total }
          : best,
      null,
    );
    const currentYear = Math.min(new Date().getUTCFullYear(), LAST_YEAR);
    const currentEntry = annual.find((entry) => entry.year === currentYear) ?? null;
    const metrics = {
      baseline_years: `${baselineStart}-${baselineEnd}`,
      baseline_mean_annual:
        baselineMeanAnnual === null ? null : Math.round(baselineMeanAnnual),
      years_with_data: withData.length,
      current_year: currentYear,
      current_year_total: currentEntry?.total ?? null,
      current_year_anomaly_pct:
        currentEntry?.total !== null &&
        currentEntry !== null &&
        baselineMeanAnnual !== null &&
        baselineMeanAnnual > 0
          ? round(((currentEntry.total - baselineMeanAnnual) / baselineMeanAnnual) * 100, 1)
          : null,
      peak_year: peak?.year ?? null,
      peak_year_total: peak?.total ?? null,
      modis_total: rawModis
        .flat()
        .reduce<number>((sum, value) => sum + (value ?? 0), 0),
      viirs_total: rawViirs
        .flat()
        .reduce<number>((sum, value) => sum + (value ?? 0), 0),
      harmonized_total: counts
        .flat()
        .reduce<number>((sum, value) => sum + (value ?? 0), 0),
    };

    return {
      mode: 'global' as const,
      region: area.region,
      bbox: area.bbox,
      period,
      months: MONTHS,
      years,
      counts,
      anomaly_pct: anomaly,
      raw_modis: rawModis,
      raw_viirs: rawViirs,
      viirs_share_pct: viirsShare,
      series,
      metrics,
      meta: {
        scope: 'global',
        source: 'NASA FIRMS / Earthdata',
        method_version:
          calibration?.method_version ?? process.env.METHOD_VERSION ?? 'h1.0',
        grid_degrees: calibration?.grid_degrees ?? this.loadRegions()?.grid_degrees ?? null,
        calibration_generated_at: calibration?.generated_at ?? null,
        baseline_years: [baselineStart, baselineEnd],
        disclaimer:
          'Global counts derived from NASA FIRMS/Earthdata active fire hotspots. For information only; does not replace official validation.',
      },
    };
  }

  /** GeoJSON hotspots for a grid cell or arbitrary bbox. */
  hotspots(params: {
    region?: string;
    bbox?: string;
    from?: string;
    to?: string;
    sensor?: string;
    limit?: string;
  }) {
    if (existsSync(this.paths.aggregatesFile)) {
      return this.hotspotsFromAggregates(params);
    }
    const area = this.resolveArea(params);
    const period = parseYearRange(params.from, params.to);
    const sensor = parseSensor(params.sensor);
    const limit = parseLimit(params.limit, HOTSPOT_LIMIT, HOTSPOT_MAX_LIMIT);
    const [west, south, east, north] = area.bbox;
    const where: string[] = [
      'year >= ?',
      'year <= ?',
      'lat >= ?',
      'lat <= ?',
      'lon >= ?',
      'lon <= ?',
      'region_id IS NOT NULL',
    ];
    const values: Array<string | number> = [
      period.from,
      period.to,
      south,
      north,
      west,
      east,
    ];
    if (area.region) {
      where.push('region_id = ?');
      values.push(area.region.id);
    }
    if (sensor === 'MODIS') where.push('has_modis = 1');
    if (sensor === 'VIIRS') where.push('has_viirs = 1');
    const clause = where.join(' AND ');

    const total = this.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM clusters WHERE ${clause}`,
      values,
    )[0]?.count;
    const rows = this.query<HotspotRow>(
      `SELECT id, lat, lon, ts_ms, year, month, region_id, biome,
              sensors, platforms, hotspot_count, has_modis, has_viirs,
              confidence, confidence_class, brightness_k, frp_mw, daynight,
              qa_flag, instrument, resolution_m
       FROM clusters
       WHERE ${clause}
       ORDER BY ts_ms DESC
       LIMIT ?`,
      [...values, limit],
    );

    const calibration = this.loadCalibration();
    const methodVersion =
      calibration?.method_version ?? process.env.METHOD_VERSION ?? 'h1.0';
    const regions = new Map(
      (this.loadRegions()?.regions ?? []).map((region) => [region.id, region]),
    );

    const features = rows.map((row) => {
      const sensors = JSON.parse(row.sensors ?? '[]') as string[];
      const platforms = JSON.parse(row.platforms ?? '[]') as string[];
      const region = regions.get(String(row.region_id));
      const factor = this.factorFor(String(row.region_id), numberOr(row.month));
      const sensorName = row.has_modis ? 'MODIS' : 'VIIRS';
      const ts = new Date(numberOr(row.ts_ms)).toISOString();
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [numberOr(row.lon), numberOr(row.lat)],
        },
        properties: {
          id: String(row.id),
          date: ts.slice(0, 10),
          ts_utc: ts,
          region_id: row.region_id,
          region_name: region?.name ?? row.region_id,
          biome: row.biome ?? region?.biome ?? null,
          sensor: sensorName,
          sensors,
          platform: platforms[0] ?? null,
          platforms,
          instrument: row.instrument,
          resolution_m: row.resolution_m,
          confidence: row.confidence,
          confidence_class: row.confidence_class,
          brightness_k: row.brightness_k,
          frp_mw: row.frp_mw,
          daynight: row.daynight,
          qa_flag: row.qa_flag,
          harmonized_weight:
            sensorName === 'MODIS' ? 1 : round(1 / (factor || 1), 3),
          hotspot_count: row.hotspot_count,
          method_version: methodVersion,
        },
      };
    });

    return {
      mode: 'global' as const,
      type: 'FeatureCollection' as const,
      total: numberOr(total),
      returned: features.length,
      features,
    };
  }

  buildCalendarCsv(params: {
    region?: string;
    bbox?: string;
    from?: string;
    to?: string;
  }) {
    const result = this.calendar(params);
    const method = result.meta.method_version ?? '';
    const name = result.region?.name ?? 'área selecionada';
    const biome = result.region?.biome ?? 'Grade global';
    const header = [
      'regiao',
      'bioma',
      'ano',
      'mes',
      'focos_harmonizados',
      'anomalia_pct',
      'focos_modis_brutos',
      'focos_viirs_brutos',
      'share_viirs_pct',
      'metodo',
      'origem',
    ];
    const lines = [header.join(SEPARATOR)];

    result.years.forEach((year, yearIndex) => {
      result.months.forEach((_, monthIndex) => {
        const count = result.counts[yearIndex][monthIndex];
        if (count === null) return;
        lines.push(
          [
            name,
            biome,
            year,
            monthIndex + 1,
            count,
            decimal(result.anomaly_pct[yearIndex][monthIndex]),
            result.raw_modis[yearIndex][monthIndex] ?? '',
            result.raw_viirs[yearIndex][monthIndex] ?? '',
            decimal(result.viirs_share_pct[yearIndex][monthIndex]),
            method,
            'NASA FIRMS (dados reais, global)',
          ].join(SEPARATOR),
        );
      });
    });

    const suffix = [params.region, params.from, params.to]
      .filter(Boolean)
      .join('_');
    return {
      filename: `carcara-orbit_global_calendario${suffix ? `_${suffix}` : ''}.csv`,
      body: `${BOM}${lines.join('\r\n')}\r\n`,
    };
  }

  buildHotspotsCsv(params: {
    region?: string;
    bbox?: string;
    from?: string;
    to?: string;
    sensor?: string;
  }) {
    const result = this.hotspots({ ...params, limit: String(HOTSPOT_MAX_LIMIT) });
    const header = [
      'lat',
      'lon',
      'date',
      'ts_utc',
      'region_id',
      'region_name',
      'biome',
      'sensor',
      'platform',
      'instrument',
      'resolution_m',
      'confidence',
      'confidence_class',
      'brightness_k',
      'frp_mw',
      'daynight',
      'qa_flag',
      'harmonized_weight',
      'method_version',
      'hotspot_count',
    ];
    const lines = [header.join(SEPARATOR)];
    for (const feature of result.features) {
      const props = feature.properties;
      const [lon, lat] = feature.geometry.coordinates;
      lines.push(
        [
          lat,
          lon,
          props.date,
          props.ts_utc,
          props.region_id ?? '',
          props.region_name ?? '',
          props.biome ?? '',
          props.sensor,
          props.platform ?? '',
          props.instrument ?? '',
          props.resolution_m ?? '',
          props.confidence ?? '',
          props.confidence_class ?? '',
          props.brightness_k ?? '',
          props.frp_mw ?? '',
          props.daynight ?? '',
          props.qa_flag ?? '',
          props.harmonized_weight ?? '',
          props.method_version ?? '',
          props.hotspot_count ?? '',
        ]
          .map((value) => String(value))
          .join(SEPARATOR),
      );
    }

    const suffix = [params.region, params.from, params.to, params.sensor]
      .filter(Boolean)
      .join('_');
    return {
      filename: `carcara-orbit_global_focos${suffix ? `_${suffix}` : ''}.csv`,
      body: `${BOM}${lines.join('\r\n')}\r\n`,
    };
  }

  private hotspotsFromAggregates(params: {
    region?: string;
    bbox?: string;
    from?: string;
    to?: string;
    sensor?: string;
    limit?: string;
  }) {
    const range = parseYearRange(params.from, params.to);
    const bbox = parseBbox(params.bbox);
    const sensor = parseSensor(params.sensor);
    const limit =
      params.limit === undefined ? HOTSPOT_LIMIT : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HOTSPOT_MAX_LIMIT) {
      throw new BadRequestException(
        `limit deve ser um inteiro entre 1 e ${HOTSPOT_MAX_LIMIT}`,
      );
    }
    const where: string[] = ['r.year >= ?', 'r.year <= ?'];
    const values: Array<string | number> = [range.from, range.to];
    if (params.region) {
      where.push('r.cell_id = ?');
      values.push(params.region);
    }
    if (sensor) {
      where.push('r.sensor = ?');
      values.push(sensor);
    }
    if (bbox) {
      where.push('r.lon >= ?', 'r.lon <= ?', 'r.lat >= ?', 'r.lat <= ?');
      values.push(bbox[0], bbox[2], bbox[1], bbox[3]);
    }
    const clause = where.join(' AND ');
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.paths.aggregatesFile, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000;');
      const total = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM recent_points r WHERE ${clause}`,
            )
            .get(...values) as { count: number }
        ).count,
      );
      const rows = db
        .prepare(
          `SELECT r.*, c.name AS region_name, c.biome AS region_biome,
                  cal.factor AS calibration_factor
           FROM recent_points r
           LEFT JOIN cells c ON c.id = r.cell_id
           LEFT JOIN calibration cal
             ON cal.cell_id = r.cell_id AND cal.month = r.month
           WHERE ${clause}
           ORDER BY r.ts_ms DESC
           LIMIT ?`,
        )
        .all(...values, limit) as unknown as AggregatePointRow[];
      const features = rows.map((row) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [row.lon, row.lat],
        },
        properties: {
          id: row.id,
          date: row.date,
          ts_utc: new Date(row.ts_ms).toISOString(),
          region_id: row.cell_id,
          region_name: row.region_name,
          biome: row.region_biome ?? 'Grade global',
          sensor: row.sensor,
          sensors: [row.sensor],
          platform: row.platform,
          platforms: row.platform ? [row.platform] : [],
          instrument: row.instrument,
          resolution_m: row.resolution_m,
          confidence: row.confidence,
          confidence_class: row.confidence_class,
          brightness_k: row.brightness_k,
          frp_mw: row.frp_mw,
          daynight: row.daynight,
          qa_flag: row.qa_flag,
          harmonized_weight:
            row.sensor === 'MODIS'
              ? 1
              : round(1 / (row.calibration_factor || 1), 3),
          hotspot_count: 1,
          method_version: row.method_version ?? 'h1.0',
        },
      }));
      return {
        mode: 'global' as const,
        type: 'FeatureCollection' as const,
        total,
        returned: features.length,
        features,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        `Falha ao ler os focos recentes do agregado: ${errorMessage(error)}`,
      );
    } finally {
      db?.close();
    }
  }

  private resolveArea(params: { region?: string; bbox?: string }) {
    if (params.region && params.bbox) {
      throw new BadRequestException('Use region ou bbox, não ambos');
    }
    if (params.region) {
      const region = this.findRegion(params.region);
      const bounds = region.bounds;
      if (!bounds) {
        throw new ServiceUnavailableException(
          `A região ${region.id} não possui bounds no arquivo de grade global.`,
        );
      }
      return { region, bbox: bounds };
    }
    const bbox = parseBbox(params.bbox) ?? ([-180, -90, 180, 90] as const);
    return { region: null, bbox };
  }

  private findRegion(id: string): GlobalRegion {
    const regions = this.loadRegions();
    if (!regions) {
      throw new ServiceUnavailableException(
        'A grade global ainda não foi gerada. Rode a ingestão global primeiro.',
      );
    }
    const region = regions.regions.find((entry) => entry.id === id);
    if (!region) throw new NotFoundException(`Região global não encontrada: ${id}`);
    return region;
  }

  private factorFor(regionId: string, month: number): number {
    const calibration = this.loadCalibration();
    const factor = calibration?.factors?.[regionId]?.[String(month)]?.factor;
    const number = Number(factor);
    return Number.isFinite(number) && number > 0 ? number : 1;
  }

  private loadRegions(): GlobalRegionsFile | null {
    try {
      const mtimeMs = statSync(this.paths.regionsFile).mtimeMs;
      if (this.regionsCache?.mtimeMs === mtimeMs) {
        return this.regionsCache.data;
      }
      const data = JSON.parse(
        readFileSync(this.paths.regionsFile, 'utf8'),
      ) as GlobalRegionsFile;
      this.regionsCache = { mtimeMs, data };
      return data;
    } catch {
      return null;
    }
  }

  private loadCalibration(): GlobalCalibration | null {
    try {
      const mtimeMs = statSync(this.paths.calibrationFile).mtimeMs;
      if (this.calibrationCache?.mtimeMs === mtimeMs) {
        return this.calibrationCache.data;
      }
      const data = JSON.parse(
        readFileSync(this.paths.calibrationFile, 'utf8'),
      ) as GlobalCalibration;
      this.calibrationCache = { mtimeMs, data };
      return data;
    } catch {
      return null;
    }
  }

  private readStatus(): GlobalIngestionStatus | null {
    try {
      return JSON.parse(
        readFileSync(this.paths.statusFile, 'utf8'),
      ) as GlobalIngestionStatus;
    } catch {
      return null;
    }
  }

  private readDatabaseStats(): GlobalDatabaseStats {
    const path = this.paths.databaseFile;
    if (!existsSync(path)) {
      return { available: false, path };
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000;');
      const hotspots = numberOr(
        (db.prepare('SELECT COUNT(*) AS count FROM hotspots').get() as {
          count: number;
        })?.count,
      );
      const clusters = numberOr(
        (db.prepare('SELECT COUNT(*) AS count FROM clusters').get() as {
          count: number;
        })?.count,
      );
      const coverage = db
        .prepare('SELECT MIN(year) AS first, MAX(year) AS last FROM hotspots')
        .get() as { first: number | null; last: number | null };
      const regions = numberOr(
        (
          db
            .prepare(
              'SELECT COUNT(DISTINCT region_id) AS count FROM hotspots WHERE region_id IS NOT NULL',
            )
            .get() as { count: number }
        )?.count,
      );
      return {
        available: true,
        path,
        hotspots,
        clusters,
        firstYear: coverage?.first ?? null,
        lastYear: coverage?.last ?? null,
        regionsWithData: regions,
        sizeBytes: statSync(path).size,
      };
    } catch (error) {
      return { available: false, path, error: errorMessage(error) };
    } finally {
      db?.close();
    }
  }

  private query<T>(sql: string, params: Array<string | number> = []): T[] {
    const path = this.paths.databaseFile;
    if (!existsSync(path)) {
      throw new ServiceUnavailableException(
        'O banco global ainda não foi gerado. Rode a ingestão global primeiro.',
      );
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000;');
      return db.prepare(sql).all(...params) as T[];
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        `Falha ao consultar o banco global: ${errorMessage(error)}`,
      );
    } finally {
      db?.close();
    }
  }
}
