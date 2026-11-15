import { createHash } from 'node:crypto';
import { normalizeHeader, parseCsv, parseCsvObjects } from '../lib/csv.js';
import { assignRegion } from '../lib/geo.js';
import { gridRegionAt } from '../lib/grid.js';
import { AppError } from '../lib/errors.js';

const CONFIDENCE_CLASSES = new Set(['low', 'nominal', 'high']);

function normalizePlatform(value) {
  const raw = String(value ?? '').trim();
  const key = raw.toLowerCase();
  if (key === 't' || key === 'terra') return 'Terra';
  if (key === 'a' || key === 'aqua') return 'Aqua';
  if (key === 'n' || key === 'npp' || key === 'snpp' || key === 'suomi npp') return 'SNPP';
  if (key === '1' || key === 'j1' || key === 'noaa-20' || key === 'noaa20') return 'NOAA-20';
  if (key === '2' || key === 'j2' || key === 'noaa-21' || key === 'noaa21') return 'NOAA-21';
  return raw || 'unknown';
}

function normalizeDayNight(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'n' || key === 'night' || key === 'noite') return 'N';
  return 'D';
}

function normalizeConfidence(value, sensor) {
  if (sensor === 'MODIS') {
    const number = Number(value);
    if (!Number.isFinite(number)) return { score: null, className: 'low' };
    if (number >= 80) return { score: number, className: 'high' };
    if (number >= 30) return { score: number, className: 'nominal' };
    return { score: number, className: 'low' };
  }

  const key = String(value ?? '').trim().toLowerCase();
  // FIRMS VIIRS files use both words (low/nominal/high) and single letters
  // (l/n/h). The Area API commonly returns single-letter codes.
  if (key === 'h' || key === 'high' || key === 'alta') return { score: 90, className: 'high' };
  if (key === 'n' || key === 'nominal' || key === 'medium' || key === 'média' || key === 'media') {
    return { score: 60, className: 'nominal' };
  }
  if (key === 'l' || key === 'low' || key === 'baixa') return { score: 20, className: 'low' };

  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number >= 80) return { score: number, className: 'high' };
    if (number >= 30) return { score: number, className: 'nominal' };
    return { score: number, className: 'low' };
  }
  return { score: null, className: 'low' };
}

function qaFlag(record) {
  const explicit = String(record.qa_flag ?? '').trim();
  if (explicit) return explicit;
  const type = String(record.type ?? '').trim();
  if (!type || type === '0') return 'ok';
  if (type === '1') return 'vulcao';
  if (type === '2') return 'outro';
  if (type === '3') return 'offshore';
  return `tipo_${type}`;
}

function headerList(text) {
  const firstLine = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const rows = parseCsv(firstLine);
  return (rows[0] ?? []).map(normalizeHeader);
}

export function detectSensor(text, { sourceMeta, fileName } = {}) {
  if (sourceMeta?.sensor) return sourceMeta.sensor;
  const headers = headerList(text);
  if (headers.includes('bright_ti4') || headers.includes('bright_ti5')) return 'VIIRS';
  if (headers.includes('brightness')) return 'MODIS';
  const lower = `${fileName ?? ''} ${headers.join(' ')}`.toLowerCase();
  if (lower.includes('viirs')) return 'VIIRS';
  if (lower.includes('modis')) return 'MODIS';
  return null;
}

function makeHotspotId({ sensor, tsUtc, lat, lon, platform }) {
  const digest = createHash('sha1')
    .update([sensor, tsUtc, lat.toFixed(5), lon.toFixed(5), platform].join('|'))
    .digest('hex')
    .slice(0, 12);
  return `${sensor}-${digest}`;
}

export function normalizeFirmsRecord(record, {
  sensor,
  sourceMeta = null,
  regions = [],
  minConfidence = 30,
  viirsMinClass = 'nominal',
  methodVersion = 'h1.0',
  keepOutsideRegions = false,
  gridDegrees = null,
  index = 0,
} = {}) {
  if (!sensor) {
    throw new AppError(400, 'UNKNOWN_SENSOR', 'A sensor is required to normalize a FIRMS record.');
  }

  const lat = Number(record.latitude ?? record.lat);
  const lon = Number(record.longitude ?? record.lon);
  const date = String(record.acq_date ?? record.date ?? '').trim();
  const rawTime = String(record.acq_time ?? record.time ?? '').replace(':', '').trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { skipped: 'invalid' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { skipped: 'invalid' };
  }

  const paddedTime = rawTime.padStart(4, '0');
  const hours = paddedTime.slice(0, 2);
  const minutes = paddedTime.slice(2, 4) || '00';
  const ts = new Date(`${date}T${hours}:${minutes}:00Z`);
  if (Number.isNaN(ts.getTime())) {
    return { skipped: 'invalid' };
  }

  const confidence = normalizeConfidence(record.confidence, sensor);
  if (!confidence.score || confidence.score < minConfidence) {
    return { skipped: 'confidence' };
  }
  // Accepts the English class names and the legacy Portuguese ones (alta/baixa) for old env files.
  const viirsMinScore = viirsMinClass === 'high' || viirsMinClass === 'alta' ? 90 : viirsMinClass === 'low' || viirsMinClass === 'baixa' ? 20 : 60;
  if (sensor === 'VIIRS' && confidence.score < viirsMinScore) {
    return { skipped: 'confidence' };
  }

  const platform = normalizePlatform(record.satellite ?? record.platform ?? sourceMeta?.defaultPlatform);
  const instrument = String(record.instrument ?? sourceMeta?.instrument ?? sensor).trim();
  const resolution = Number(record.resolution_m ?? sourceMeta?.resolutionM ?? (sensor === 'MODIS' ? 1000 : 375));
  const brightness = Number(record.brightness ?? record.bright_ti4 ?? record.bright_ti5 ?? record.brightness_k);
  const frp = Number(record.frp ?? record.frp_mw);
  const region =
    gridDegrees !== null && gridDegrees !== undefined
      ? gridRegionAt(lat, lon, gridDegrees)
      : regions.length > 0
        ? assignRegion({ lat, lon }, regions)
        : null;

  if (regions.length > 0 && !gridDegrees && !region && !keepOutsideRegions) {
    return { skipped: 'outside' };
  }

  const tsUtc = ts.toISOString();
  return {
    hotspot: {
      id: makeHotspotId({ sensor, tsUtc, lat, lon, platform }),
      lat,
      lon,
      date,
      ts_utc: tsUtc,
      ts_ms: ts.getTime(),
      year: ts.getUTCFullYear(),
      month: ts.getUTCMonth() + 1,
      region_id: region?.id ?? null,
      biome: region?.biome ?? null,
      sensor,
      platform,
      instrument,
      resolution_m: Number.isFinite(resolution) ? resolution : null,
      confidence: Number.isFinite(confidence.score) ? Math.round(confidence.score) : null,
      confidence_class: confidence.className,
      brightness_k: Number.isFinite(brightness) ? brightness : null,
      frp_mw: Number.isFinite(frp) ? frp : null,
      daynight: normalizeDayNight(record.daynight ?? record.day_night),
      qa_flag: qaFlag(record),
      source: sourceMeta?.code ?? record.source ?? sensor,
      source_row: index + 2,
      method_version: methodVersion,
    },
  };
}

export function normalizeFirmsCsv(text, {
  sourceMeta = null,
  sensor = null,
  fileName = '',
  regions = [],
  minConfidence = 30,
  viirsMinClass = 'nominal',
  methodVersion = 'h1.0',
  keepOutsideRegions = false,
  gridDegrees = null,
} = {}) {
  const detectedSensor = sensor ?? detectSensor(text, { sourceMeta, fileName });
  if (!detectedSensor) {
    throw new AppError(400, 'UNKNOWN_SENSOR', `Could not detect MODIS/VIIRS for ${fileName || 'CSV input'}.`);
  }

  const records = parseCsvObjects(text);
  const hotspots = [];
  const stats = {
    file: fileName || null,
    sensor: detectedSensor,
    rows: records.length,
    kept: 0,
    skippedInvalid: 0,
    skippedConfidence: 0,
    skippedOutsideRegions: 0,
    byRegion: {},
  };

  records.forEach((record, index) => {
    const result = normalizeFirmsRecord(record, {
      sensor: detectedSensor,
      sourceMeta,
      regions,
      minConfidence,
      viirsMinClass,
      methodVersion,
      keepOutsideRegions,
      gridDegrees,
      index,
    });
    if (!result.hotspot) {
      if (result.skipped === 'invalid') stats.skippedInvalid += 1;
      else if (result.skipped === 'confidence') stats.skippedConfidence += 1;
      else if (result.skipped === 'outside') stats.skippedOutsideRegions += 1;
      return;
    }
    const { hotspot } = result;
    stats.kept += 1;
    stats.byRegion[hotspot.region_id ?? 'outside'] = (stats.byRegion[hotspot.region_id ?? 'outside'] ?? 0) + 1;
    hotspots.push(hotspot);
  });

  return { hotspots, stats };
}

export function normalizeCsvFiles(files, options = {}) {
  const hotspots = [];
  const stats = [];
  for (const file of files) {
    const result = normalizeFirmsCsv(file.text, { ...options, fileName: file.path });
    hotspots.push(...result.hotspots);
    stats.push(result.stats);
  }

  return {
    hotspots,
    stats,
    totalRows: stats.reduce((acc, item) => acc + item.rows, 0),
    skippedInvalid: stats.reduce((acc, item) => acc + item.skippedInvalid, 0),
    skippedConfidence: stats.reduce((acc, item) => acc + item.skippedConfidence, 0),
    skippedOutsideRegions: stats.reduce((acc, item) => acc + item.skippedOutsideRegions, 0),
  };
}

export { CONFIDENCE_CLASSES };
