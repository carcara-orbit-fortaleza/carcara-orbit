import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../lib/errors.js';
import { bboxOfPolygon } from '../lib/geo.js';
import { fetchFirmsCsv } from '../pipeline/firms.js';

export const BACKFILL_SOURCES = {
  MODIS_SP: { sensor: 'MODIS', start: '2000-11-01', end: null },
  VIIRS_SNPP_SP: { sensor: 'VIIRS', start: '2012-01-20', end: '2026-11-02' },
  VIIRS_NOAA20_SP: { sensor: 'VIIRS', start: '2018-04-01', end: null },
  VIIRS_NOAA21_SP: { sensor: 'VIIRS', start: '2023-03-01', end: null },
};

const DEFAULT_BBOX = { west: -74, south: -34, east: -34, north: 6 };
const MAX_CHUNK_DAYS = 5;

function isoDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function maxISO(a, b) {
  return a > b ? a : b;
}

function minISO(a, b) {
  return a < b ? a : b;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseBbox(value) {
  if (value === undefined || value === null || value === '') return { ...DEFAULT_BBOX };
  if (value === 'world') return { west: -180, south: -90, east: 180, north: 90 };
  const parts = String(value).split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new AppError(400, 'INVALID_BBOX', 'bbox must be west,south,east,north');
  }
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) {
    throw new AppError(400, 'INVALID_BBOX', 'bbox must satisfy west < east and south < north');
  }
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new AppError(400, 'INVALID_BBOX', 'bbox is outside valid longitude/latitude bounds');
  }
  return { west, south, east, north };
}

export function resolveBbox({ bbox, region, config }) {
  if (bbox && region) {
    throw new AppError(400, 'BBOX_CONFLICT', 'Use either --bbox or --region, not both.');
  }
  if (region) {
    const found = config.regions.find((item) => item.id === region);
    if (!found) {
      throw new AppError(400, 'UNKNOWN_REGION', `Unknown region: ${region}`);
    }
    return bboxOfPolygon(found.polygon);
  }
  return parseBbox(bbox);
}

export function bboxLabel(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north]
    .map((value) => Number(value).toFixed(4))
    .join(',');
}

function loadCheckpoint(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, updatedAt: null, chunks: {} };
  }
}

function saveCheckpoint(file, checkpoint) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

function writeCsv(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  rmSync(file, { force: true });
  renameSync(temporary, file);
}

function csvStats(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return { rows: 0, header: '', bytes: 0 };
  const header = lines[0].toLowerCase();
  return {
    rows: Math.max(0, lines.length - 1),
    header,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function isFatal(error) {
  if (error instanceof AppError) {
    if (error.code === 'FIRMS_KEY_MISSING') return true;
    const body = error.details?.body ?? '';
    return /invalid (area|date)|map.?key|unauthor|forbidden|401|403/i.test(
      `${error.message} ${body}`,
    );
  }
  return false;
}

export function buildBackfillPlan({
  sources,
  start,
  end,
  chunkDays = MAX_CHUNK_DAYS,
  today = new Date(),
}) {
  const sourceList = sources?.length ? sources : Object.keys(BACKFILL_SOURCES);
  const chunkSize = Math.max(1, Math.min(MAX_CHUNK_DAYS, Number(chunkDays) || MAX_CHUNK_DAYS));
  const todayIso = formatDate(today);
  const requestedStart = start ? isoDate(start) : null;
  const requestedEnd = end ? isoDate(end) : null;
  if (start && !requestedStart) throw new AppError(400, 'INVALID_START', 'start must be YYYY-MM-DD');
  if (end && !requestedEnd) throw new AppError(400, 'INVALID_END', 'end must be YYYY-MM-DD');
  if (requestedStart && requestedEnd && requestedStart > requestedEnd) {
    throw new AppError(400, 'INVALID_RANGE', 'start must be before or equal to end');
  }

  const plan = [];
  const sourceRanges = {};
  for (const source of sourceList) {
    const definition = BACKFILL_SOURCES[source];
    if (!definition?.start) {
      throw new AppError(400, 'UNKNOWN_SOURCE', `Unknown backfill source: ${source}`);
    }
    if (!isoDate(definition.start) || (definition.end && !isoDate(definition.end))) {
      throw new AppError(
        400,
        'INVALID_SOURCE_RANGE',
        `Source ${source} has invalid coverage dates: ${definition.start} - ${definition.end ?? 'present'}`,
      );
    }
    const fromIso = maxISO(requestedStart ? formatDate(requestedStart) : definition.start, definition.start);
    const toIso = minISO(
      requestedEnd ? formatDate(requestedEnd) : (definition.end ?? todayIso),
      definition.end ?? todayIso,
    );
    sourceRanges[source] = { from: fromIso, to: toIso };
    if (fromIso > toIso) continue;

    let cursor = isoDate(fromIso);
    const last = isoDate(toIso);
    while (cursor <= last) {
      const chunkEnd = minISO(formatDate(addDays(cursor, chunkSize - 1)), toIso);
      plan.push({ source, start: formatDate(cursor), end: chunkEnd });
      cursor = addDays(cursor, chunkSize);
    }
  }

  return { plan, sourceRanges, chunkSize };
}

export async function runBackfill({
  config,
  sources,
  start,
  end,
  bbox,
  region,
  outputDir,
  checkpointFile,
  chunkDays = MAX_CHUNK_DAYS,
  requestDelayMs = 1200,
  maxRequests,
  dryRun = false,
  reset = false,
  logger = console,
  fetchImpl = fetch,
  today = new Date(),
} = {}) {
  if (!config?.firms?.baseUrl) throw new Error('config.firms.baseUrl is required');
  const resolvedBbox = resolveBbox({ bbox, region, config });
  const output = path.resolve(outputDir ?? path.join(config.repoRoot, 'data', 'raw'));
  const checkpointPath = path.resolve(
    checkpointFile ?? path.join(config.repoRoot, 'data', 'runtime', 'backfill.json'),
  );
  const { plan, sourceRanges, chunkSize } = buildBackfillPlan({
    sources,
    start,
    end,
    chunkDays,
    today,
  });
  const bboxValue = bboxLabel(resolvedBbox);
  const checkpoint = reset ? { version: 1, chunks: {} } : loadCheckpoint(checkpointPath);
  checkpoint.chunks = checkpoint.chunks ?? {};
  checkpoint.version = 1;
  checkpoint.bbox = bboxValue;
  checkpoint.sources = sourceRanges;
  checkpoint.chunk_days = chunkSize;

  const keyFor = (chunk) => `${chunk.source}|${bboxValue}|${chunk.start}|${chunk.end}`;
  const pending = plan.filter((chunk) => {
    const status = checkpoint.chunks[keyFor(chunk)]?.status;
    return status !== 'done' && status !== 'empty';
  });
  const skipped = plan.length - pending.length;

  if (dryRun) {
    return {
      dryRun: true,
      bbox: bboxValue,
      chunkDays: chunkSize,
      sources: sourceRanges,
      planned: plan.length,
      pending: pending.length,
      skipped,
      firstChunks: pending.slice(0, 20),
      checkpointFile: checkpointPath,
      outputDir: output,
    };
  }

  let attempted = 0;
  let downloaded = 0;
  let empty = 0;
  let errors = 0;
  let rows = 0;
  let bytes = 0;
  let stoppedReason = null;
  const max = maxRequests === undefined ? Infinity : Math.max(1, Number(maxRequests));

  for (const chunk of pending) {
    if (attempted >= max) {
      stoppedReason = 'maxRequests';
      break;
    }
    attempted += 1;
    const key = keyFor(chunk);
    const dayRange = daysBetween(isoDate(chunk.start), isoDate(chunk.end)) + 1;

    try {
      const response = await fetchFirmsCsv({
        baseUrl: config.firms.baseUrl,
        mapKey: config.firms.mapKey,
        source: chunk.source,
        bbox: resolvedBbox,
        dayRange,
        date: chunk.start,
        timeoutMs: config.firms.timeoutMs,
        fetchImpl,
      });
      const stats = csvStats(response.text);
      if (stats.rows === 0) {
        checkpoint.chunks[key] = {
          status: 'empty',
          source: chunk.source,
          start: chunk.start,
          end: chunk.end,
          at: new Date().toISOString(),
        };
        empty += 1;
      } else {
        const relative = path.join(chunk.source, `${chunk.start}_${chunk.end}.csv`);
        const file = path.join(output, relative);
        writeCsv(file, response.text);
        checkpoint.chunks[key] = {
          status: 'done',
          source: chunk.source,
          start: chunk.start,
          end: chunk.end,
          file: relative,
          rows: stats.rows,
          bytes: stats.bytes,
          at: new Date().toISOString(),
        };
        downloaded += 1;
        rows += stats.rows;
        bytes += stats.bytes;
      }
      checkpoint.updatedAt = new Date().toISOString();
      saveCheckpoint(checkpointPath, checkpoint);
      if (downloaded % 25 === 0 || attempted === pending.length) {
        logger.info?.(
          `Backfill ${attempted}/${pending.length} chunks · ${downloaded} files · ${rows} rows`,
        );
      }
    } catch (error) {
      checkpoint.chunks[key] = {
        status: 'error',
        source: chunk.source,
        start: chunk.start,
        end: chunk.end,
        error: error.message,
        at: new Date().toISOString(),
      };
      checkpoint.updatedAt = new Date().toISOString();
      saveCheckpoint(checkpointPath, checkpoint);
      errors += 1;
      logger.warn?.(`Backfill failed ${chunk.source} ${chunk.start}: ${error.message}`);
      if (isFatal(error)) {
        stoppedReason = error.message;
        break;
      }
    }

    if (requestDelayMs > 0 && attempted < pending.length) {
      await sleep(requestDelayMs);
    }
  }

  saveCheckpoint(checkpointPath, checkpoint);
  return {
    dryRun: false,
    bbox: bboxValue,
    chunkDays: chunkSize,
    sources: sourceRanges,
    planned: plan.length,
    pending: pending.length,
    skipped,
    attempted,
    downloaded,
    empty,
    errors,
    rows,
    bytes,
    remaining: Math.max(0, pending.length - attempted),
    stoppedReason,
    checkpointFile: checkpointPath,
    outputDir: output,
  };
}
