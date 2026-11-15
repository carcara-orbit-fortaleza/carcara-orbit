import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { BACKFILL_SOURCES } from '../backfill/backfill.js';

export const FIRMS_COUNTRY_INDEX_URL =
  'https://firms.modaps.eosdis.nasa.gov/data/country/yearly_summary_files.txt';
export const FIRMS_COUNTRY_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/country/';

function sourceFromPrefix(prefix) {
  const value = String(prefix ?? '').toLowerCase();
  if (value.startsWith('modis')) return 'MODIS_SP';
  if (value.includes('snpp')) return 'VIIRS_SNPP_SP';
  if (value.includes('jpss1') || value.includes('noaa20') || value.includes('noaa-20')) {
    return 'VIIRS_NOAA20_SP';
  }
  if (value.includes('jpss2') || value.includes('noaa21') || value.includes('noaa-21')) {
    return 'VIIRS_NOAA21_SP';
  }
  return null;
}

function normalizeCountry(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export function parseCountryIndex(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  const start = header.startsWith('filename,') ? 1 : 0;
  const entries = [];
  for (const line of lines.slice(start)) {
    const [filename, size, updated] = line.split(',');
    if (!filename || !filename.toLowerCase().endsWith('.csv')) continue;
    const match = filename.match(/^([a-z0-9-]+)_(\d{4})_(.+)\.csv$/i);
    if (!match) continue;
    const sourceCode = sourceFromPrefix(match[1]);
    if (!sourceCode) continue;
    entries.push({
      filename,
      size: Number(size) || 0,
      updated: updated ?? null,
      year: Number(match[2]),
      country: match[3],
      sourceCode,
      sensor: BACKFILL_SOURCES[sourceCode]?.sensor ?? (sourceCode === 'MODIS_SP' ? 'MODIS' : 'VIIRS'),
    });
  }
  return entries;
}

export function buildCountryPlan({
  indexText,
  country,
  countries,
  startYear,
  endYear,
  sources,
} = {}) {
  const requested =
    countries === 'all'
      ? null
      : countries !== undefined
        ? (Array.isArray(countries) ? countries : [countries])
        : [country ?? 'Brazil'];
  const wantedCountries =
    requested === null ? null : new Set(requested.map(normalizeCountry));
  const wantedSources = sources?.length ? new Set(sources) : null;

  return parseCountryIndex(indexText)
    .filter(
      (entry) =>
        wantedCountries === null ||
        wantedCountries.has(normalizeCountry(entry.country)),
    )
    .filter((entry) => (startYear === undefined ? true : entry.year >= Number(startYear)))
    .filter((entry) => (endYear === undefined ? true : entry.year <= Number(endYear)))
    .filter((entry) => !wantedSources || wantedSources.has(entry.sourceCode))
    .sort(
      (a, b) =>
        a.country.localeCompare(b.country) ||
        a.year - b.year ||
        a.sourceCode.localeCompare(b.sourceCode),
    );
}

async function loadCheckpoint(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, files: {} };
    throw error;
  }
}

async function saveCheckpoint(filePath, checkpoint) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadOne({
  url,
  destination,
  fetchImpl,
  timeoutMs,
}) {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'carcara-api/0.1 (+https://github.com/carcara-orbit-fortaleza/research-base)',
      Accept: 'text/csv,application/octet-stream;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new Error(`Empty response body for ${url}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await streamPipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Downloads the public yearly FIRMS country CSVs. This index is linked from the
 * FIRMS Archive Download page and does not require an authenticated session.
 */
export async function downloadCountryCsvs({
  country,
  countries,
  startYear,
  endYear,
  sources,
  outputDir,
  checkpointFile,
  indexUrl = FIRMS_COUNTRY_INDEX_URL,
  baseUrl = FIRMS_COUNTRY_BASE_URL,
  includeCountryInPath = false,
  fetchImpl = fetch,
  requestDelayMs = 500,
  timeoutMs = 600_000,
  maxFiles,
  dryRun = false,
  reset = false,
  onProgress = null,
  logger = console,
} = {}) {
  const indexResponse = await fetchImpl(indexUrl, {
    headers: {
      'User-Agent': 'carcara-api/0.1 (+https://github.com/carcara-orbit-fortaleza/research-base)',
      Accept: 'text/plain,text/csv,*/*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!indexResponse.ok) {
    throw new Error(`FIRMS country index returned HTTP ${indexResponse.status}.`);
  }
  const indexText = await indexResponse.text();
  if (/^\s*</.test(indexText)) {
    throw new Error('FIRMS country index returned HTML instead of the CSV file list.');
  }

  const plan = buildCountryPlan({
    indexText,
    country,
    countries,
    startYear,
    endYear,
    sources,
  });
  const resolvedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const scope =
    countries === 'all'
      ? 'the global index'
      : countries !== undefined
        ? (Array.isArray(countries) ? countries : [countries]).join(', ')
        : (country ?? 'Brazil');
  if (plan.length === 0) {
    throw new Error(
      `No FIRMS country CSVs found for ${scope} between ${startYear ?? 'first'} and ${endYear ?? 'last'} (${sources?.join(', ') ?? 'all sources'}).`,
    );
  }

  const checkpoint = reset ? { version: 1, files: {} } : await loadCheckpoint(checkpointFile);
  checkpoint.files = checkpoint.files ?? {};
  const limit = maxFiles === undefined ? Infinity : Math.max(1, Number(maxFiles));
  let attempted = 0;
  let downloaded = 0;
  let skipped = 0;
  let bytes = 0;
  const errors = [];

  const reportProgress = async (current) => {
    await onProgress?.({
      planned: plan.length,
      attempted,
      downloaded,
      skipped,
      bytes,
      errors: errors.length,
      current,
    });
  };

  for (const entry of plan) {
    if (attempted >= limit) break;
    const countryDir = includeCountryInPath ? normalizeCountry(entry.country) : '';
    const destination = path.join(
      outputDir,
      countryDir,
      entry.sourceCode,
      entry.filename,
    );
    const relative = path.relative(outputDir, destination).split(path.sep).join('/');
    const previous = checkpoint.files[relative];

    if (existsSync(destination)) {
      const info = await stat(destination);
      if (!entry.size || info.size === entry.size) {
        checkpoint.files[relative] = {
          ...previous,
          size: info.size,
          expectedSize: entry.size,
          year: entry.year,
          source: entry.sourceCode,
          status: 'done',
        };
        skipped += 1;
        await reportProgress(relative);
        continue;
      }
      await rm(destination, { force: true });
    }

    attempted += 1;
    if (dryRun) {
      logger.info?.(`[dry-run] ${entry.country} ${entry.sourceCode} ${entry.year}: ${entry.filename}`);
      await reportProgress(relative);
      continue;
    }

    const url = new URL(entry.filename, resolvedBaseUrl).toString();
    try {
      await downloadOne({ url, destination, fetchImpl, timeoutMs });
      const info = await stat(destination);
      if (entry.size && info.size !== entry.size) {
        throw new Error(`expected ${entry.size} bytes, received ${info.size}`);
      }
      bytes += info.size;
      downloaded += 1;
      checkpoint.files[relative] = {
        size: info.size,
        expectedSize: entry.size,
        year: entry.year,
        source: entry.sourceCode,
        country: entry.country,
        status: 'done',
        at: new Date().toISOString(),
      };
      await saveCheckpoint(checkpointFile, checkpoint);
      logger.info?.(
        `Downloaded ${downloaded}/${plan.length} · ${entry.country} ${entry.sourceCode} ${entry.year} · ${info.size} bytes`,
      );
    } catch (error) {
      errors.push({ file: entry.filename, country: entry.country, error: error.message });
      checkpoint.files[relative] = {
        ...previous,
        status: 'error',
        error: error.message,
        at: new Date().toISOString(),
      };
      await saveCheckpoint(checkpointFile, checkpoint);
      logger.warn?.(`Failed ${entry.filename}: ${error.message}`);
    }
    await reportProgress(relative);

    if (requestDelayMs > 0 && attempted < plan.length) {
      await sleep(requestDelayMs);
    }
  }

  return {
    country: country ?? null,
    countries: countries === 'all' ? 'all' : (countries ?? null),
    planned: plan.length,
    attempted,
    downloaded,
    skipped,
    bytes,
    errors,
    dryRun,
    outputDir,
    checkpointFile,
    firstFiles: plan.slice(0, 20).map((entry) => ({
      country: entry.country,
      source: entry.sourceCode,
      year: entry.year,
      file: entry.filename,
    })),
  };
}
