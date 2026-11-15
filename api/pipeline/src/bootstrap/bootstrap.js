import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../lib/errors.js';
import {
  closeFirmsDatabase,
  countClusters,
  countHotspots,
  openFirmsDatabase,
  upsertHotspots,
} from '../db/database.js';
import { importCsvFilesToDatabase } from '../db/import.js';
import { rebuildDatasetFromDatabase } from '../db/rebuild.js';
import { downloadCountryCsvs } from '../history/country.js';
import { fetchCurrentHotspots } from '../nrt/refresh.js';

const HISTORY_SOURCES = ['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP'];

/**
 * Reports the state of the SQLite database that now owns the historical
 * hotspot rows. The JSON files in `data/real` are generated from it.
 */
export async function inspectDatabase({ config, csvDir } = {}) {
  if (!config?.database?.filePath) throw new Error('config.database.filePath is required');
  const filePath = config.database.filePath;
  const exists = existsSync(filePath);
  let storedHotspots = 0;
  let clusters = 0;
  if (exists) {
    const db = openFirmsDatabase({ filePath });
    storedHotspots = countHotspots(db);
    clusters = countClusters(db);
    closeFirmsDatabase(db);
  }
  return {
    empty: storedHotspots === 0,
    exists,
    storedHotspots,
    clusters,
    paths: {
      databaseFile: filePath,
      rawCsvDir: path.resolve(csvDir ?? path.join(config.storageDir, 'raw', 'country')),
      realDir: config.realDir,
    },
  };
}

/**
 * Populates the SQLite database from the public FIRMS yearly country CSVs and
 * uses the FIRMS Area API only for the current NRT window.
 *
 * Flow:
 * 1. scrape the country CSV index and download the historical archives;
 * 2. stream every CSV under `data/raw` into SQLite;
 * 3. fetch the current NRT window through the API and upsert it;
 * 4. rebuild `data/real` from the database.
 */
export async function runBootstrap({
  config,
  force = false,
  rebuildOnly = false,
  reset = false,
  dryRun = false,
  country = config?.history?.country ?? 'Brazil',
  startYear = config?.history?.startYear ?? 2000,
  endYear = new Date().getUTCFullYear() - 1,
  sources = HISTORY_SOURCES,
  includeCurrent = true,
  allowPartial = false,
  currentDays = config?.nrt?.days ?? 2,
  featureMonths = config?.database?.featureMonths ?? 24,
  csvDir,
  maxFiles,
  maxImportFiles,
  requestDelayMs,
  currentYear = new Date().getUTCFullYear(),
  generatedAt = new Date().toISOString(),
  fetchImpl = fetch,
  logger = console,
} = {}) {
  if (!config?.database?.filePath) throw new Error('config.database.filePath is required');

  const rawDir = path.resolve(csvDir ?? path.join(config.storageDir, 'raw', 'country'));
  const runtimeDir = path.join(config.repoRoot, 'data', 'runtime');
  const historyCheckpoint = path.join(runtimeDir, 'country-download.json');
  const importCheckpoint = path.join(runtimeDir, 'import.json');
  const database = await inspectDatabase({ config, csvDir: rawDir });
  const warnings = [];

  if (!force && !reset && !rebuildOnly && !database.empty) {
    return {
      skipped: true,
      reason: 'database-not-empty',
      database,
      history: null,
      imported: null,
      current: null,
      rebuild: null,
      warnings,
    };
  }

  const reason = reset ? 'reset' : force ? 'forced' : 'database-empty';

  if (dryRun) {
    let history = null;
    if (!rebuildOnly) {
      try {
        history = await downloadCountryCsvs({
          country,
          startYear,
          endYear,
          sources,
          outputDir: rawDir,
          checkpointFile: historyCheckpoint,
          indexUrl: config.history?.indexUrl,
          baseUrl: config.history?.baseUrl,
          requestDelayMs,
          maxFiles,
          dryRun: true,
          fetchImpl,
          logger,
        });
      } catch (error) {
        warnings.push(error.message);
      }
    }
    return {
      skipped: false,
      dryRun: true,
      reason,
      database,
      history,
      imported: null,
      current: includeCurrent && !rebuildOnly
        ? { days: currentDays, sources: config.firms?.sources ?? [] }
        : null,
      rebuild: { databaseFile: config.database.filePath, outputDir: config.realDir, featureMonths },
      warnings,
    };
  }

  const db = openFirmsDatabase({ filePath: config.database.filePath, reset });
  const importReset = reset || database.empty;

  let history = null;
  if (!rebuildOnly) {
    try {
      logger.info?.(`Scraping FIRMS country CSV index for ${country}…`);
      history = await downloadCountryCsvs({
        country,
        startYear,
        endYear,
        sources,
        outputDir: rawDir,
        checkpointFile: historyCheckpoint,
        indexUrl: config.history?.indexUrl,
        baseUrl: config.history?.baseUrl,
        requestDelayMs,
        maxFiles,
        reset,
        fetchImpl,
        logger,
      });
    } catch (error) {
      warnings.push(`Historical download failed: ${error.message}`);
      logger.warn?.(warnings.at(-1));
    }
  }

  logger.info?.('Importing CSV files into SQLite…');
  const imported = await importCsvFilesToDatabase({
    db,
    inputDir: rawDir,
    config,
    checkpointFile: importCheckpoint,
    maxFiles: maxImportFiles,
    reset: importReset,
    logger,
  });

  let current = null;
  if (!rebuildOnly && includeCurrent) {
    if (config.firms?.mapKey) {
      try {
        logger.info?.(`Fetching current NRT data (${currentDays} days) through the FIRMS API…`);
        const fetched = await fetchCurrentHotspots({
          config,
          days: Math.max(1, Math.min(5, Number(currentDays) || config.nrt.days)),
          fetchImpl,
          logger,
        });
        await upsertHotspots(db, fetched.hotspots);
        current = {
          fetched: fetched.hotspots.length,
          errors: fetched.errors,
        };
        warnings.push(
          ...fetched.errors.map((error) => `NRT ${error.regionId}/${error.source}: ${error.message}`),
        );
      } catch (error) {
        current = { fetched: 0, errors: [{ message: error.message }] };
        warnings.push(`Current data failed: ${error.message}`);
        logger.warn?.(warnings.at(-1));
      }
    } else {
      warnings.push('FIRMS_MAP_KEY is not set; current NRT data was skipped.');
    }
  }

  const incompleteHistory =
    history && !maxFiles && history.downloaded + history.skipped < history.planned;
  const importErrors = imported.errors > 0;
  const historyErrors = (history?.errors?.length ?? 0) > 0;
  if (!allowPartial && (incompleteHistory || importErrors || historyErrors)) {
    closeFirmsDatabase(db);
    throw new AppError(
      502,
      'BOOTSTRAP_INCOMPLETE',
      'The historical import is incomplete; keeping the previous data/real dataset. ' +
        'Re-run to resume or pass --allow-partial to rebuild with what was imported.',
      { history, imported, warnings },
    );
  }

  const totalHotspots = countHotspots(db);
  if (totalHotspots === 0) {
    closeFirmsDatabase(db);
    throw new AppError(
      502,
      'BOOTSTRAP_NO_DATA',
      'No historical CSVs were imported and no current data was fetched.',
      { database, imported, current, warnings },
    );
  }

  logger.info?.('Rebuilding data/real from SQLite…');
  const result = await rebuildDatasetFromDatabase({
    db,
    config,
    featureMonths,
    generatedAt,
    currentYear,
    logger,
  });
  const after = {
    ...database,
    empty: false,
    storedHotspots: totalHotspots,
    clusters: countClusters(db),
  };
  closeFirmsDatabase(db);

  return {
    skipped: false,
    dryRun: false,
    reason,
    database: after,
    history,
    imported,
    current,
    rebuild: {
      outputDir: result.outputDir,
      inputHotspots: result.inputHotspots,
      clusters: result.clusters,
      exportedHotspots: result.exportedHotspots,
      mapHotspots: result.mapHotspots,
      featureMonths,
      warnings: result.warnings,
    },
    warnings,
  };
}
