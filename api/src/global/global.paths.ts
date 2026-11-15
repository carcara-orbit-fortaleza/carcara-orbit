import { join } from 'node:path';

export interface GlobalPaths {
  databaseFile: string;
  rawDir: string;
  regionsFile: string;
  calibrationFile: string;
  statusFile: string;
  logFile: string;
  downloadCheckpoint: string;
  importCheckpoint: string;
}

/**
 * Resolves the global ingestion artifacts. The defaults mirror the pipeline
 * config so the API and the CLI always point at the same files.
 */
export function globalPaths(env: NodeJS.ProcessEnv = process.env): GlobalPaths {
  const dataDir = join(process.cwd(), 'data');
  return {
    databaseFile: env.GLOBAL_DB_PATH ?? join(dataDir, 'db', 'global.sqlite'),
    rawDir: env.GLOBAL_RAW_DIR ?? join(dataDir, 'raw', 'global'),
    regionsFile:
      env.GLOBAL_REGIONS_FILE ?? join(dataDir, 'runtime', 'global-regions.json'),
    calibrationFile:
      env.GLOBAL_CALIBRATION_FILE ??
      join(dataDir, 'runtime', 'global-calibration.json'),
    statusFile:
      env.GLOBAL_STATUS_FILE ?? join(dataDir, 'runtime', 'global-ingestion.json'),
    logFile:
      env.GLOBAL_LOG_FILE ?? join(dataDir, 'runtime', 'global-ingestion.log'),
    downloadCheckpoint:
      env.GLOBAL_DOWNLOAD_CHECKPOINT ??
      join(dataDir, 'runtime', 'global-download.json'),
    importCheckpoint:
      env.GLOBAL_IMPORT_CHECKPOINT ??
      join(dataDir, 'runtime', 'global-import.json'),
  };
}
