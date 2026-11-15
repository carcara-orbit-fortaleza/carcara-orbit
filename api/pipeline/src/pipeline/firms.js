import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../lib/errors.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildAreaUrl({ baseUrl, mapKey, source, bbox, dayRange, date }) {
  if (!mapKey) {
    throw new AppError(503, 'FIRMS_KEY_MISSING', 'FIRMS_MAP_KEY is not configured. Set it in .env or the environment.');
  }
  if (!bbox || !Number.isFinite(bbox.west) || !Number.isFinite(bbox.south) || !Number.isFinite(bbox.east) || !Number.isFinite(bbox.north)) {
    throw new AppError(400, 'INVALID_BBOX', 'A valid bounding box is required.');
  }
  const range = Math.max(1, Math.min(5, Number(dayRange) || 1));
  const area = [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((value) => Number(value).toFixed(4))
    .join(',');
  const parts = [
    baseUrl.replace(/\/+$/, ''),
    'api',
    'area',
    'csv',
    encodeURIComponent(mapKey),
    encodeURIComponent(source),
    area,
    String(range),
  ];
  if (date) parts.push(encodeURIComponent(date));
  return parts.join('/');
}

export async function fetchFirmsCsv({
  baseUrl,
  mapKey,
  source,
  bbox,
  dayRange,
  date,
  timeoutMs = 45000,
  fetchImpl = fetch,
  retries = 2,
}) {
  const url = buildAreaUrl({ baseUrl, mapKey, source, bbox, dayRange, date });
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'carcara-api/0.1 (+https://github.com/carcara-orbit-fortaleza/research-base)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new AppError(
          502,
          'FIRMS_HTTP_ERROR',
          `FIRMS returned HTTP ${response.status} for ${source}.`,
          { status: response.status, body: body.slice(0, 300) },
        );
      }
      const text = await response.text();
      if (/^\s*</.test(text) || /<html/i.test(text)) {
        throw new AppError(502, 'FIRMS_INVALID_RESPONSE', `FIRMS returned HTML instead of CSV for ${source}.`);
      }
      return { url, text, source };
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof AppError) || error.status >= 500;
      if (!retryable || attempt === retries) break;
      await delay(800 * (attempt + 1));
    }
  }

  if (lastError instanceof AppError) throw lastError;
  throw new AppError(502, 'FIRMS_FETCH_FAILED', `Could not fetch FIRMS data for ${source}: ${lastError?.message ?? 'unknown error'}`);
}

export async function readCsvInputs(inputPath) {
  const info = await stat(inputPath);
  const files = [];

  async function readOne(filePath) {
    const text = await readFile(filePath, 'utf8');
    files.push({ path: filePath, text });
  }

  if (info.isFile()) {
    await readOne(inputPath);
  } else if (info.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      const child = path.join(inputPath, entry.name);
      if (entry.isDirectory()) {
        try {
          const nested = await readCsvInputs(child);
          files.push(...nested);
        } catch (error) {
          if (error.code !== 'NO_CSV_INPUT') throw error;
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
        paths.push(child);
      }
    }
    paths.sort();
    for (const filePath of paths) {
      await readOne(filePath);
    }
  } else {
    throw new AppError(400, 'INVALID_INPUT', `Input is not a file or directory: ${inputPath}`);
  }

  if (files.length === 0) {
    throw new AppError(400, 'NO_CSV_INPUT', `No CSV files found in ${inputPath}. Download FIRMS archive CSVs and place them there.`);
  }
  return files;
}

export function pickArchiveSource(config, sensor, fileName = '') {
  const lower = fileName.toLowerCase();
  const definitions = config.sourceDefinitions;
  const candidates = Object.entries(definitions)
    .filter(([, definition]) => definition.sensor === sensor)
    .map(([code, definition]) => ({ code, ...definition }));

  if (sensor === 'MODIS') {
    return candidates.find((entry) => entry.code === 'MODIS_SP') ?? candidates[0] ?? { code: 'MODIS_SP', sensor: 'MODIS', resolutionM: 1000, instrument: 'MODIS C6.1', defaultPlatform: 'Terra/Aqua' };
  }

  if (lower.includes('snpp') || lower.includes('suomi')) {
    return candidates.find((entry) => entry.code === 'VIIRS_SNPP_SP') ?? candidates[0];
  }
  if (lower.includes('noaa21') || lower.includes('noaa-21')) {
    return candidates.find((entry) => entry.code === 'VIIRS_NOAA21_SP') ?? candidates[0];
  }
  if (lower.includes('noaa20') || lower.includes('noaa-20')) {
    return candidates.find((entry) => entry.code === 'VIIRS_NOAA20_SP') ?? candidates[0];
  }
  return candidates.find((entry) => entry.code === 'VIIRS_NOAA20_SP') ?? candidates[0] ?? {
    code: 'VIIRS_NOAA20_SP',
    sensor: 'VIIRS',
    resolutionM: 375,
    instrument: 'VIIRS 375m',
    defaultPlatform: 'NOAA-20',
  };
}

export async function waitBetweenRequests(config) {
  if (config.firms.requestDelayMs > 0) {
    await delay(config.firms.requestDelayMs);
  }
}
