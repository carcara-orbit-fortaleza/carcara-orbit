#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { readJson } from './lib/json-store.js';
import { createLogger } from './lib/logger.js';
import { runBackfill } from './backfill/backfill.js';
import { runBootstrap } from './bootstrap/bootstrap.js';
import {
  closeFirmsDatabase,
  countHotspots,
  openFirmsDatabase,
  readDatabaseStats,
  upsertHotspots,
} from './db/database.js';
import { importCsvFilesToDatabase } from './db/import.js';
import { rebuildDatasetFromDatabase } from './db/rebuild.js';
import { runPipelineFromCsvFiles } from './pipeline/run.js';
import { fetchCurrentHotspots, refreshRealData } from './nrt/refresh.js';

const HELP = `
CarcarÃ¡ pipeline worker

Usage:
  node pipeline/src/cli.js pipeline --input <csv-file-or-directory> [--out <directory>] [--json]
  node pipeline/src/cli.js nrt [--days 2] [--regions pantanal,cerrado] [--json]
  node pipeline/src/cli.js backfill [options]
  node pipeline/src/cli.js bootstrap [options]
  node pipeline/src/cli.js status [--json]

Commands:
  pipeline    Normalize FIRMS CSV files, calibrate, harmonize and write data/real
  nrt         Fetch the latest FIRMS NRT data, merge it with stored history and rebuild
  backfill    Download historical FIRMS SP data in 5-day chunks with a resumable checkpoint
  bootstrap   Populate an empty database with historical MODIS/VIIRS data and build data/real
  status      Show dataset availability and NRT status

Backfill options:
  --start YYYY-MM-DD          Start date (source-specific minimum by default)
  --end YYYY-MM-DD            End date (today / source-specific maximum by default)
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP
  --bbox=west,south,east,north Default: -74,-34,-34,6 (Brazil)
                               Use '=' because coordinates start with '-'
  --region pantanal           Use a configured region bbox instead of --bbox
  --out data/raw              Output directory
  --checkpoint <file>         Default: data/runtime/backfill.json
  --chunk-days 5              FIRMS Area API maximum is 5
  --request-delay 1200        Milliseconds between requests
  --max-requests N            Stop after N attempts (useful for a pilot)
  --dry-run                   Show the plan without downloading
  --reset                     Ignore previous checkpoints

Bootstrap options:
  --country Brazil            Country used in the public FIRMS yearly CSVs
  --start-year 2000           First historical year (inclusive)
  --end-year YYYY             Last historical year (default: current year - 1)
  --sources MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP,VIIRS_NOAA21_SP
  --days 2                    Current NRT window fetched through the API (max 5)
  --feature-months 24         Months exported to hotspots.geojson
  --csv-dir data/raw/country  Directory with historical CSVs
  --max-files N               Limit historical CSV downloads (pilot)
  --max-import-files N        Limit CSV files imported into SQLite (pilot)
  --no-current                Do not fetch the current NRT window from the API
  --allow-partial             Rebuild data/real even if downloads/imports had errors
  --force                     Import/fetch again even when the database has data
  --rebuild-only              Skip downloads/API and rebuild data/real from SQLite
  --reset                     Recreate the SQLite database and checkpoints

Environment:
  Loaded from the project root .env. FIRMS_MAP_KEY is required for NRT/bootstrap/backfill.
`;

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withoutDataset(result) {
  if (!result) return result;
  const { dataset, ...rest } = result;
  return rest;
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function commandBackfill(values) {
  const config = await loadConfig({});
  const sources = values.sources
    ? String(values.sources).split(',').map((item) => item.trim()).filter(Boolean)
    : undefined;
  const result = await runBackfill({
    config,
    sources,
    start: values.start,
    end: values.end,
    bbox: values.bbox,
    region: values.region,
    outputDir: values.out ? path.resolve(values.out) : undefined,
    checkpointFile: values.checkpoint ? path.resolve(values.checkpoint) : undefined,
    chunkDays: values['chunk-days'] ? Number(values['chunk-days']) : undefined,
    requestDelayMs: values['request-delay'] ? Number(values['request-delay']) : undefined,
    maxRequests: values['max-requests'] ? Number(values['max-requests']) : undefined,
    dryRun: Boolean(values['dry-run']),
    reset: Boolean(values.reset),
    logger: values.json ? silentLogger : console,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.dryRun) {
    console.log('Backfill plan');
    console.log(`  Bbox:       ${result.bbox}`);
    console.log(`  Chunk days: ${result.chunkDays}`);
    console.log(`  Planned:    ${result.planned}`);
    console.log(`  Pending:    ${result.pending}`);
    console.log(`  Skipped:    ${result.skipped}`);
    for (const chunk of result.firstChunks) {
      console.log(`    - ${chunk.source} ${chunk.start}..${chunk.end}`);
    }
    console.log(`  Checkpoint: ${result.checkpointFile}`);
    console.log(`  Output:     ${result.outputDir}`);
    return;
  }

  console.log('Backfill complete.');
  console.log(`  Bbox:        ${result.bbox}`);
  console.log(`  Planned:     ${result.planned}`);
  console.log(`  Pending:     ${result.pending}`);
  console.log(`  Skipped:     ${result.skipped}`);
  console.log(`  Attempted:   ${result.attempted}`);
  console.log(`  Downloaded:  ${result.downloaded}`);
  console.log(`  Empty:       ${result.empty}`);
  console.log(`  Errors:      ${result.errors}`);
  console.log(`  Rows:        ${result.rows}`);
  console.log(`  Bytes:       ${result.bytes}`);
  console.log(`  Remaining:   ${result.remaining}`);
  if (result.stoppedReason) console.log(`  Stopped:     ${result.stoppedReason}`);
  console.log(`  Checkpoint:  ${result.checkpointFile}`);
  console.log(`  Output:      ${result.outputDir}`);
}

async function commandBootstrap(values) {
  const config = await loadConfig({});
  const sources = values.sources
    ? String(values.sources).split(',').map((item) => item.trim()).filter(Boolean)
    : undefined;
  const result = await runBootstrap({
    config,
    sources,
    country: values.country,
    startYear: values['start-year'] ? Number(values['start-year']) : undefined,
    endYear: values['end-year'] ? Number(values['end-year']) : undefined,
    currentDays: values.days ? Number(values.days) : undefined,
    featureMonths: values['feature-months'] ? Number(values['feature-months']) : undefined,
    csvDir: values['csv-dir'] ? path.resolve(values['csv-dir']) : undefined,
    maxFiles: values['max-files'] ? Number(values['max-files']) : undefined,
    maxImportFiles: values['max-import-files'] ? Number(values['max-import-files']) : undefined,
    requestDelayMs: values['request-delay'] ? Number(values['request-delay']) : undefined,
    force: Boolean(values.force),
    rebuildOnly: Boolean(values['rebuild-only']),
    includeCurrent: !values['no-current'],
    allowPartial: Boolean(values['allow-partial']),
    dryRun: Boolean(values['dry-run']),
    reset: Boolean(values.reset),
    logger: values.json ? silentLogger : console,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.skipped) {
    console.log(`Database already populated (${result.database.storedHotspots} hotspots).`);
    console.log(`  SQLite:      ${result.database.paths.databaseFile}`);
    console.log('  Nothing to do. Use --force to import/fetch again or --reset to rebuild it.');
    return;
  }

  if (result.dryRun) {
    console.log('Bootstrap plan');
    console.log(`  Database empty: ${result.database.empty ? 'yes' : 'no'}`);
    console.log(`  SQLite:         ${result.database.paths.databaseFile}`);
    console.log(`  Raw CSVs:       ${result.database.paths.rawCsvDir}`);
    console.log(`  Data/real:      ${result.database.paths.realDir}`);
    if (result.history) {
      console.log(`  History plan:   ${result.history.planned} CSVs (${result.history.country})`);
      for (const file of result.history.firstFiles) {
        console.log(`    - ${file.source} ${file.year}: ${file.file}`);
      }
    } else {
      console.log('  History:        skipped (--rebuild-only)');
    }
    if (result.current) {
      console.log(`  Current:        API, last ${result.current.days} days (${result.current.sources.join(', ')})`);
    } else {
      console.log('  Current:        skipped');
    }
    for (const warning of result.warnings) console.log(`  Warning:        ${warning}`);
    return;
  }

  console.log('Bootstrap complete.');
  console.log(`  Reason:         ${result.reason}`);
  console.log(`  SQLite:         ${result.database.paths.databaseFile}`);
  console.log(`  Hotspots:       ${result.rebuild.inputHotspots}`);
  console.log(`  Clusters:       ${result.rebuild.clusters}`);
  console.log(`  Real dataset:   ${result.rebuild.outputDir}`);
  if (result.history) {
    console.log(`  History CSVs:   ${result.history.downloaded} downloaded, ${result.history.skipped} already present`);
    console.log(`  History errors: ${result.history.errors.length}`);
  }
  if (result.imported) {
    console.log(`  Imported:       ${result.imported.imported} files, ${result.imported.rows} rows, ${result.imported.kept} hotspots kept`);
    console.log(`  Import errors:  ${result.imported.errors}`);
  }
  if (result.current) {
    console.log(`  Current:        ${result.current.fetched} hotspots fetched`);
    console.log(`  Current errors: ${result.current.errors?.length ?? 0}`);
  }
  for (const warning of result.warnings) console.log(`  Warning:        ${warning}`);
}

async function commandPipeline(values) {
  const config = await loadConfig({ nrtEnabled: false });
  const inputPath = path.resolve(
    values.input ?? path.join(config.storageDir, 'raw', 'country'),
  );
  const outputDir = path.resolve(values.out ?? config.realDir);
  const inputIsDirectory = existsSync(inputPath) && statSync(inputPath).isDirectory();

  if (existsSync(config.database.filePath) && inputIsDirectory) {
    const db = openFirmsDatabase({ filePath: config.database.filePath });
    try {
      const imported = await importCsvFilesToDatabase({
        db,
        inputDir: inputPath,
        config,
        checkpointFile: path.join(config.repoRoot, 'data', 'runtime', 'import.json'),
        logger: values.json ? silentLogger : console,
      });
      const result = await rebuildDatasetFromDatabase({
        db,
        config,
        outputDir,
        featureMonths: config.database.featureMonths,
        logger: values.json ? silentLogger : console,
      });
      const summary = {
        storage: 'sqlite',
        imported,
        inputHotspots: result.inputHotspots,
        clusters: result.clusters,
        exportedHotspots: result.exportedHotspots,
        mapHotspots: result.mapHotspots,
        outputDir: result.outputDir,
        warnings: result.warnings,
      };
      if (values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log('Pipeline complete (SQLite).');
      console.log(`  Imported files: ${imported.imported}`);
      console.log(`  Input hotspots: ${summary.inputHotspots}`);
      console.log(`  Clusters:       ${summary.clusters}`);
      console.log(`  Exported:       ${summary.exportedHotspots}`);
      console.log(`  Map sample:     ${summary.mapHotspots}`);
      console.log(`  Output:         ${summary.outputDir}`);
      console.log(`  Warnings:       ${summary.warnings.length}`);
      return;
    } finally {
      closeFirmsDatabase(db);
    }
  }

  const result = await runPipelineFromCsvFiles({
    inputPath,
    config,
    outputDir,
  });

  if (values.json) {
    console.log(JSON.stringify(withoutDataset(result), null, 2));
    return;
  }

  console.log('Pipeline complete.');
  console.log(`  Input hotspots: ${result.inputHotspots}`);
  console.log(`  Clusters:       ${result.clusters}`);
  console.log(`  Exported:       ${result.exportedHotspots}`);
  console.log(`  Map sample:     ${result.mapHotspots}`);
  console.log(`  Output:         ${result.outputDir}`);
  console.log(`  Warnings:       ${result.warnings.length}`);
  for (const warning of result.warnings.slice(0, 10)) console.log(`    - ${warning}`);
  if (result.warnings.length > 10) console.log(`    ... ${result.warnings.length - 10} more`);
}

async function commandNrt(values) {
  const config = await loadConfig({});
  const logger = createLogger(config.logLevel);
  const regionIds = values.regions
    ? String(values.regions).split(',').map((item) => item.trim()).filter(Boolean)
    : config.nrt.regions;
  const days = parseNumber(values.days, config.nrt.days);
  if (!config.firms.mapKey) {
    throw new Error('FIRMS_MAP_KEY is not set. Create the project root .env or set the environment variable.');
  }

  if (existsSync(config.database.filePath)) {
    const db = openFirmsDatabase({ filePath: config.database.filePath });
    try {
      const before = countHotspots(db);
      const fetched = await fetchCurrentHotspots({
        config,
        regionIds,
        days,
        logger,
      });
      await upsertHotspots(db, fetched.hotspots);
      const total = countHotspots(db);
      if (total === 0) {
        throw new Error('No NRT hotspots were fetched and the SQLite database is empty.');
      }
      const refreshMonths = new Map();
      for (const hotspot of fetched.hotspots) {
        refreshMonths.set(`${hotspot.year}-${hotspot.month}`, {
          year: hotspot.year,
          month: hotspot.month,
        });
        const previous = new Date(Date.UTC(hotspot.year, hotspot.month - 2, 1));
        refreshMonths.set(`${previous.getUTCFullYear()}-${previous.getUTCMonth() + 1}`, {
          year: previous.getUTCFullYear(),
          month: previous.getUTCMonth() + 1,
        });
      }
      const result = await rebuildDatasetFromDatabase({
        db,
        config,
        featureMonths: config.database.featureMonths,
        refreshMonths: [...refreshMonths.values()],
        logger,
      });
      const summary = {
        storage: 'sqlite',
        fetched: fetched.hotspots.length,
        existing: before,
        total,
        clusters: result.clusters,
        outputDir: result.outputDir,
        errors: fetched.errors,
      };
      if (values.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      console.log('NRT refresh complete (SQLite).');
      console.log(`  Fetched:        ${summary.fetched}`);
      console.log(`  Stored before:  ${summary.existing}`);
      console.log(`  Total hotspots: ${summary.total}`);
      console.log(`  Clusters:       ${summary.clusters}`);
      console.log(`  Output:         ${summary.outputDir}`);
      console.log(`  Errors:         ${summary.errors.length}`);
      for (const error of summary.errors.slice(0, 10)) {
        console.log(`    - ${error.regionId}/${error.source}: ${error.message}`);
      }
      return;
    } finally {
      closeFirmsDatabase(db);
    }
  }

  const result = await refreshRealData({
    config,
    regionIds,
    days,
    logger,
  });

  if (values.json) {
    console.log(JSON.stringify(withoutDataset(result), null, 2));
    return;
  }

  console.log('NRT refresh complete.');
  console.log(`  Fetched:        ${result.fetched}`);
  console.log(`  Stored before:  ${result.existing}`);
  console.log(`  Total hotspots: ${result.total}`);
  console.log(`  Clusters:       ${result.clusters}`);
  console.log(`  Output:         ${result.outputDir}`);
  console.log(`  Errors:         ${result.errors.length}`);
  for (const error of result.errors.slice(0, 10)) {
    console.log(`    - ${error.regionId}/${error.source}: ${error.message}`);
  }
}

async function commandStatus(values) {
  const config = await loadConfig({});
  const stored = await readJson(config.nrt.statusFile, null);
  let database = {
    available: existsSync(config.database.filePath),
    filePath: config.database.filePath,
    hotspots: 0,
    clusters: 0,
  };
  if (database.available) {
    try {
      database = { ...database, ...readDatabaseStats(config.database.filePath) };
    } catch {
      // The database may be locked or mid-import; report availability only.
    }
  }
  const status = {
    mode: config.mode,
    availability: {
      mock: { available: existsSync(path.join(config.mockDir, 'calendario.json')) },
      real: { available: existsSync(path.join(config.realDir, 'calendario.json')) },
    },
    database,
    nrt: {
      enabled: config.nrt.enabled,
      intervalMinutes: config.nrt.intervalMinutes,
      regions: config.nrt.regions,
      sources: config.firms.sources,
      keyConfigured: Boolean(config.firms.mapKey),
      stored,
    },
    files: {
      mockCalendar: path.join(config.mockDir, 'calendario.json'),
      realCalendar: path.join(config.realDir, 'calendario.json'),
      realRaw: config.nrt.rawPath,
    },
  };

  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Mode: ${status.mode}`);
  console.log(`Mock dataset: ${status.availability.mock.available ? 'available' : 'missing'}`);
  console.log(`Real dataset: ${status.availability.real.available ? 'available' : 'missing'}`);
  console.log(`SQLite: ${status.database.available ? `${status.database.hotspots} hotspots, ${status.database.clusters} clusters` : 'missing'}`);
  console.log(`SQLite file: ${status.database.filePath}`);
  console.log(`NRT enabled: ${status.nrt.enabled ? 'yes' : 'no'}`);
  console.log(`FIRMS key: ${status.nrt.keyConfigured ? 'configured' : 'missing'}`);
  if (stored) {
    console.log(`NRT last run: ${stored.lastRun ?? 'â€”'}`);
    console.log(`NRT last success: ${stored.lastSuccess ?? 'â€”'}`);
    console.log(`NRT last error: ${stored.lastError?.message ?? 'â€”'}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      out: { type: 'string' },
      days: { type: 'string' },
      regions: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      sources: { type: 'string' },
      bbox: { type: 'string' },
      region: { type: 'string' },
      checkpoint: { type: 'string' },
      'chunk-days': { type: 'string' },
      'request-delay': { type: 'string' },
      'max-requests': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'rebuild-only': { type: 'boolean', default: false },
      'no-current': { type: 'boolean', default: false },
      'allow-partial': { type: 'boolean', default: false },
      country: { type: 'string' },
      'start-year': { type: 'string' },
      'end-year': { type: 'string' },
      'feature-months': { type: 'string' },
      'csv-dir': { type: 'string' },
      'max-files': { type: 'string' },
      'max-import-files': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP.trim());
    return;
  }

  const command = positionals[0] ?? 'status';
  if (command === 'pipeline') {
    await commandPipeline(values);
    return;
  }
  if (command === 'nrt') {
    await commandNrt(values);
    return;
  }
  if (command === 'backfill') {
    await commandBackfill(values);
    return;
  }
  if (command === 'bootstrap') {
    await commandBootstrap(values);
    return;
  }
  if (command === 'status') {
    await commandStatus(values);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(HELP.trim());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
