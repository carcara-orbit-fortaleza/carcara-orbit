import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/json-store.js';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const API_ROOT = path.resolve(SOURCE_DIR, '..');
export const REPO_ROOT = path.resolve(API_ROOT, '..');

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value) {
  if (!value) return null;
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDotEnv(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

async function loadEnv(apiRoot, repoRoot) {
  const env = { ...process.env };
  for (const file of [path.join(repoRoot, '.env'), path.join(apiRoot, '.env')]) {
    try {
      const text = await readFile(file, 'utf8');
      const parsed = parseDotEnv(text);
      for (const [key, value] of Object.entries(parsed)) {
        if (env[key] === undefined || env[key] === '') env[key] = value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return env;
}

export async function loadConfig(overrides = {}) {
  const apiRoot = path.resolve(overrides.apiRoot ?? API_ROOT);
  const repoRoot = path.resolve(overrides.repoRoot ?? REPO_ROOT);
  const env = overrides.env ?? await loadEnv(apiRoot, repoRoot);
  const storageDir = path.resolve(overrides.storageDir ?? env.STORAGE_DIR ?? path.join(repoRoot, 'data'));
  const mockDir = path.resolve(overrides.mockDir ?? path.join(repoRoot, 'data', 'mock'));
  const realDir = path.resolve(overrides.realDir ?? path.join(storageDir, 'real'));
  const configDir = path.join(apiRoot, 'config');

  const regionsFile = path.resolve(
    overrides.regionsFile ??
      (env.REGIONS_FILE || path.join(configDir, 'regions.json')),
  );
  const regions =
    overrides.regions ??
    JSON.parse(await readFile(regionsFile, 'utf8'));
  const sourceConfig =
    overrides.sources ??
    JSON.parse(await readFile(path.join(configDir, 'sources.json'), 'utf8'));
  const sourceDefinitions = sourceConfig.sources ?? sourceConfig;

  const modeFile = path.join(repoRoot, 'data', 'runtime', 'mode.json');
  const storedMode = overrides.mode ?? (await readJson(modeFile, null))?.mode;
  const mode = storedMode ?? env.DATA_SOURCE ?? 'mock';
  if (!['mock', 'real'].includes(mode)) {
    throw new Error(`Invalid DATA_SOURCE/mode: ${mode}. Use "mock" or "real".`);
  }

  const nrtSources =
    parseList(env.FIRMS_SOURCES) ??
    overrides.nrtSources ??
    sourceConfig.defaultNrtSources ??
    Object.keys(sourceDefinitions).filter((key) => sourceDefinitions[key].kind === 'nrt');

  const archiveSources =
    parseList(env.FIRMS_ARCHIVE_SOURCES) ??
    sourceConfig.defaultArchiveSources ??
    Object.keys(sourceDefinitions).filter((key) => sourceDefinitions[key].kind === 'archive');

  const nrtRegions =
    parseList(env.NRT_REGIONS) ??
    overrides.nrtRegions ??
    regions.map((region) => region.id);

  return {
    apiRoot,
    repoRoot,
    configDir,
    storageDir,
    mockDir,
    realDir,
    modeFile,
    mode,
    database: {
      filePath: path.resolve(
        overrides.databaseFile ??
          env.FIRMS_DB_PATH ??
          path.join(storageDir, 'db', 'firms.sqlite'),
      ),
      featureMonths: parseIntEnv(env.HOTSPOTS_EXPORT_MONTHS, 24),
    },
    regionsFile,
    history: {
      country: overrides.country ?? (env.FIRMS_COUNTRY || 'Brazil'),
      startYear: parseIntEnv(env.FIRMS_HISTORY_START_YEAR, 2000),
      indexUrl:
        env.FIRMS_COUNTRY_INDEX_URL ??
        'https://firms.modaps.eosdis.nasa.gov/data/country/yearly_summary_files.txt',
      baseUrl:
        env.FIRMS_COUNTRY_BASE_URL ??
        'https://firms.modaps.eosdis.nasa.gov/data/country/',
    },
    regions,
    sourceConfig,
    sourceDefinitions,
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    port: parseIntEnv(overrides.port ?? env.PORT, 8787),
    corsOrigin: overrides.corsOrigin ?? env.CORS_ORIGIN ?? '*',
    adminToken: overrides.adminToken ?? env.ADMIN_TOKEN ?? '',
    logLevel: overrides.logLevel ?? env.LOG_LEVEL ?? 'info',
    methodVersion: overrides.methodVersion ?? env.METHOD_VERSION ?? 'h1.0',
    baseline: {
      startYear: parseIntEnv(env.BASELINE_START_YEAR, 2003),
      endYear: parseIntEnv(env.BASELINE_END_YEAR, 2025),
    },
    calibration: {
      startYear: parseIntEnv(env.CALIBRATION_START_YEAR, 2012),
      endYear: parseIntEnv(env.CALIBRATION_END_YEAR, 2025),
      minCells: parseIntEnv(env.CALIBRATION_MIN_CELLS, 30),
      shrinkageK: parseNumberEnv(env.CALIBRATION_SHRINKAGE_K, 20),
      minFactor: parseNumberEnv(env.CALIBRATION_MIN_FACTOR, 0.5),
      maxFactor: parseNumberEnv(env.CALIBRATION_MAX_FACTOR, 4.0),
    },
    limits: {
      maxMapPoints: parseIntEnv(env.MAX_MAP_POINTS, 2000),
      maxExportRows: parseIntEnv(env.MAX_EXPORT_ROWS, 50000),
    },
    firms: {
      mapKey: overrides.firmsMapKey ?? env.FIRMS_MAP_KEY ?? '',
      baseUrl: (overrides.firmsBaseUrl ?? env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov').replace(/\/+$/, ''),
      sources: nrtSources,
      archiveSources,
      timeoutMs: parseIntEnv(env.FIRMS_TIMEOUT_MS, 45000),
      requestDelayMs: parseIntEnv(env.FIRMS_REQUEST_DELAY_MS, 600),
      modisMinConfidence: parseIntEnv(env.MODIS_MIN_CONFIDENCE, 30),
      viirsMinClass: env.VIIRS_MIN_CLASS ?? 'nominal',
    },
    nrt: {
      enabled: overrides.nrtEnabled ?? env.NRT_ENABLED === 'true',
      intervalMinutes: parseIntEnv(env.NRT_INTERVAL_MINUTES, 180),
      days: parseIntEnv(env.NRT_DAYS, 2),
      regions: nrtRegions,
      statusFile: path.join(repoRoot, 'data', 'runtime', 'nrt-status.json'),
      rawPath: path.join(realDir, 'raw', 'hotspots.jsonl'),
    },
    publicCsv: {
      window: env.PUBLIC_CSV_WINDOW ?? '7d',
      sources: parseList(env.PUBLIC_CSV_SOURCES) ?? ['MODIS', 'NOAA20', 'NOAA21'],
      pages: parseList(env.FIRMS_CSV_PAGES) ?? [],
      extraUrls: parseList(env.FIRMS_EXTRA_CSV_URLS) ?? [],
      maxMb: parseIntEnv(env.MAX_CSV_MB, 100),
      delayMs: parseIntEnv(env.FIRMS_CSV_DELAY_MS, 1000),
      timeoutMs: parseIntEnv(env.FIRMS_CSV_TIMEOUT_MS, 120000),
      autoCollectOnStart: env.AUTO_COLLECT_ON_START === 'true',
      autoBuildOnStart: env.AUTO_BUILD_ON_START === 'true',
    },
  };
}
