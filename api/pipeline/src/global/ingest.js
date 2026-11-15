import {
  countClusters,
  countDistinctRegions,
  countHotspots,
  openFirmsDatabase,
  closeFirmsDatabase,
  queryCalibrationCellCounts,
  queryRegionClusterCounts,
  setMeta,
  upsertHotspots,
} from '../db/database.js';
import { importCsvFilesToDatabase } from '../db/import.js';
import { refreshClusters } from '../db/rebuild.js';
import { downloadCountryCsvs } from '../history/country.js';
import { buildGridRegions, normalizeGridDegrees } from '../lib/grid.js';
import { writeJsonAtomic } from '../lib/json-store.js';
import { calibrateFactorsFromCellCounts } from '../pipeline/calibrate.js';
import { fetchGlobalCurrentHotspots } from './current.js';

export const GLOBAL_HISTORY_SOURCES = [
  'MODIS_SP',
  'VIIRS_SNPP_SP',
  'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_SP',
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeErrors(errors) {
  return {
    count: errors.length,
    first: errors.slice(0, 10),
  };
}

function summarizeHistory(history) {
  if (!history) return null;
  return {
    planned: history.planned,
    attempted: history.attempted,
    downloaded: history.downloaded,
    skipped: history.skipped,
    bytes: history.bytes,
    errors: summarizeErrors(history.errors ?? []),
  };
}

function summarizeImport(imported) {
  if (!imported) return null;
  return {
    files: imported.files,
    imported: imported.imported,
    skipped: imported.skipped,
    rows: imported.rows,
    kept: imported.kept,
    errors: imported.errors,
  };
}

function normalizeCountries(countries) {
  if (countries === 'all') return 'all';
  if (Array.isArray(countries)) {
    return countries.map((country) => String(country).trim()).filter(Boolean);
  }
  if (typeof countries === 'string' && countries.trim() !== '') {
    return countries
      .split(',')
      .map((country) => country.trim())
      .filter(Boolean);
  }
  return 'all';
}

/**
 * Full-world historical ingestion.
 *
 * Downloads every FIRMS yearly country CSV (resumable), imports into a dedicated
 * global SQLite database, assigns detections to a world grid, rebuilds clusters
 * and calibration, and optionally fetches the current NRT window.
 */
export async function runGlobalIngestion({
  config,
  countries = 'all',
  startYear = config.global?.startYear ?? 2000,
  endYear = config.global?.endYear ?? new Date().getUTCFullYear() - 1,
  sources = GLOBAL_HISTORY_SOURCES,
  gridDegrees = config.global?.gridDegrees ?? 10,
  nrtTileDegrees = config.global?.nrtTileDegrees ?? 30,
  maxFiles = config.global?.maxFiles,
  maxImportFiles,
  includeCurrent = false,
  currentDays = config.nrt?.days ?? 2,
  allowPartial = true,
  dryRun = false,
  reset = false,
  rebuildOnly = false,
  fetchImpl = fetch,
  logger = console,
  generatedAt = new Date().toISOString(),
  currentYear = new Date().getUTCFullYear(),
  statusFile = config.global?.statusFile,
} = {}) {
  if (!config?.global) throw new Error('config.global is required');
  if (!statusFile) throw new Error('config.global.statusFile is required');

  const size = normalizeGridDegrees(gridDegrees);
  const requestedCountries = normalizeCountries(countries);
  const regions = buildGridRegions(size);
  const state = {
    version: 1,
    running: true,
    phase: 'starting',
    startedAt: generatedAt,
    finishedAt: null,
    options: {
      countries: requestedCountries,
      startYear,
      endYear,
      sources,
      gridDegrees: size,
      maxFiles: maxFiles ?? null,
      maxImportFiles: maxImportFiles ?? null,
      includeCurrent,
      currentDays,
      allowPartial,
      dryRun,
      reset,
      rebuildOnly,
    },
    progress: {},
    result: null,
    error: null,
  };

  const saveStatus = async () => {
    try {
      await writeJsonAtomic(statusFile, state);
    } catch (error) {
      logger.warn?.(`Could not write global ingestion status: ${errorMessage(error)}`);
    }
  };

  const update = async (phase, progress = {}, extra = {}) => {
    state.phase = phase;
    state.progress = { ...state.progress, ...progress };
    Object.assign(state, extra);
    await saveStatus();
  };

  await update('preparing', {
    gridDegrees: size,
    regions: regions.length,
  });

  let db = null;
  try {
    await writeJsonAtomic(config.global.regionsFile, {
      scope: 'global',
      grid_degrees: size,
      generated_at: generatedAt,
      regions,
    });

    if (dryRun) {
      const history = await downloadCountryCsvs({
        countries: requestedCountries,
        startYear,
        endYear,
        sources,
        outputDir: config.global.rawDir,
        checkpointFile: config.global.downloadCheckpoint,
        includeCountryInPath: true,
        maxFiles,
        dryRun: true,
        fetchImpl,
        logger,
        onProgress: (progress) => update('downloading', progress),
      });
      state.phase = 'done';
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.result = {
        dryRun: true,
        countries: requestedCountries,
        gridDegrees: size,
        regions: regions.length,
        history: summarizeHistory(history),
        databaseFile: config.global.databaseFile,
        rawDir: config.global.rawDir,
      };
      await saveStatus();
      return state.result;
    }

    db = openFirmsDatabase({
      filePath: config.global.databaseFile,
      reset,
    });
    setMeta(db, 'scope', 'global');
    setMeta(db, 'grid_degrees', size);
    setMeta(db, 'generated_at', generatedAt);

    let history = null;
    if (!rebuildOnly) {
      await update('downloading', {});
      history = await downloadCountryCsvs({
        countries: requestedCountries,
        startYear,
        endYear,
        sources,
        outputDir: config.global.rawDir,
        checkpointFile: config.global.downloadCheckpoint,
        includeCountryInPath: true,
        maxFiles,
        reset,
        fetchImpl,
        logger,
        onProgress: (progress) => update('downloading', progress),
      });
    }

    let imported = null;
    if (!rebuildOnly) {
      await update('importing', {});
      imported = await importCsvFilesToDatabase({
        db,
        inputDir: config.global.rawDir,
        config,
        checkpointFile: config.global.importCheckpoint,
        maxFiles: maxImportFiles,
        reset,
        gridDegrees: size,
        logger,
        onProgress: (progress) => update('importing', progress),
      });
    }

    let current = null;
    if (!rebuildOnly && includeCurrent) {
      await update('current', {});
      current = await fetchGlobalCurrentHotspots({
        config,
        days: Math.max(1, Math.min(5, Number(currentDays) || 2)),
        tileDegrees: nrtTileDegrees,
        gridDegrees: size,
        fetchImpl,
        logger,
        onProgress: (progress) => update('current', progress),
      });
      await upsertHotspots(db, current.hotspots);
    }

    const incompleteHistory =
      history && history.downloaded + history.skipped < history.planned;
    const incompleteImport =
      imported &&
      maxImportFiles !== undefined &&
      imported.imported + imported.skipped < imported.files;
    const importErrors = (imported?.errors ?? 0) > 0;
    const historyErrors = (history?.errors?.length ?? 0) > 0;
    if (
      !allowPartial &&
      (incompleteHistory || incompleteImport || importErrors || historyErrors)
    ) {
      const error = new Error(
        'Global historical ingestion is incomplete. Re-run to resume or set allowPartial=true.',
      );
      error.details = {
        history: summarizeHistory(history),
        imported: summarizeImport(imported),
      };
      throw error;
    }

    const totalHotspots = countHotspots(db);
    if (totalHotspots === 0) {
      throw new Error(
        'No global hotspots were imported. Check network access, the FIRMS index and the selected filters.',
      );
    }

    await update('clustering', {});
    await refreshClusters(db, {
      logger,
      onProgress: (progress) => update('clustering', progress),
    });

    await update('calibrating', {});
    const calibrationStart = config.calibration?.startYear ?? 2012;
    const calibrationEnd = config.calibration?.endYear ?? 2025;
    const regionClusterCounts = {};
    for (const row of queryRegionClusterCounts(db, calibrationStart, calibrationEnd)) {
      regionClusterCounts[row.region_id] = {
        total: Number(row.total) || 0,
        daytime: Number(row.daytime) || 0,
      };
    }
    const activeRegionIds = new Set(Object.keys(regionClusterCounts));
    const calibrationRegions = regions.filter((region) =>
      activeRegionIds.has(region.id),
    );
    const calibration = calibrateFactorsFromCellCounts(
      queryCalibrationCellCounts(db, calibrationStart, calibrationEnd),
      {
        regions: calibrationRegions,
        regionClusterCounts,
        calibration: config.calibration,
        methodVersion: config.methodVersion,
      },
    );
    await writeJsonAtomic(config.global.calibrationFile, {
      scope: 'global',
      grid_degrees: size,
      generated_at: generatedAt,
      ...calibration,
    });

    const clusters = countClusters(db);
    const regionsWithData = countDistinctRegions(db);
    const partial = Boolean(
      incompleteHistory || incompleteImport || importErrors || historyErrors,
    );
    const result = {
      dryRun: false,
      partial,
      countries: requestedCountries,
      gridDegrees: size,
      regions: regions.length,
      regionsWithData,
      databaseFile: config.global.databaseFile,
      rawDir: config.global.rawDir,
      hotspots: totalHotspots,
      clusters,
      history: summarizeHistory(history),
      imported: summarizeImport(imported),
      current: current
        ? {
            fetched: current.hotspots.length,
            tiles: current.tiles,
            sources: current.sources,
            errors: summarizeErrors(current.errors),
          }
        : null,
      calibration: {
        file: config.global.calibrationFile,
        regions: calibrationRegions.length,
        window: calibration.calibration_window,
        warnings: calibration.warnings.length,
      },
      warnings: [
        ...(history?.errors ?? []).slice(0, 5).map((entry) => entry.error),
        ...(current?.errors ?? []).slice(0, 5).map((entry) => entry.message),
        ...calibration.warnings.slice(0, 5),
      ],
    };

    state.phase = 'done';
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.result = result;
    await saveStatus();
    return result;
  } catch (error) {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.error = errorMessage(error);
    if (error.details) state.errorDetails = error.details;
    await saveStatus();
    throw error;
  } finally {
    if (db) closeFirmsDatabase(db);
  }
}
