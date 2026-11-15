import { createReadStream } from 'node:fs';
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseCsv, normalizeHeader } from '../lib/csv.js';
import { detectSensor, normalizeFirmsRecord } from '../pipeline/normalize.js';
import { pickArchiveSource } from '../pipeline/firms.js';
import { upsertHotspots } from './database.js';

const BATCH_SIZE = 2000;

export async function listCsvFiles(inputDir) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) files.push(child);
    }
  }
  await walk(inputDir);
  files.sort();
  return files;
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

function rowToRecord(headers, cells) {
  const record = {};
  headers.forEach((header, index) => {
    record[header] = (cells[index] ?? '').trim();
  });
  return record;
}

async function importOneFile({
  db,
  filePath,
  config,
  onBatch,
}) {
  const headerStream = createReadStream(filePath, { encoding: 'utf8' });
  const headerLines = readline.createInterface({ input: headerStream, crlfDelay: Infinity });
  let headerLine = null;
  for await (const line of headerLines) {
    if (line.trim() !== '') {
      headerLine = line;
      break;
    }
  }
  headerLines.close();
  headerStream.destroy();

  if (!headerLine) return { rows: 0, kept: 0, skippedInvalid: 0, skippedConfidence: 0, skippedOutside: 0 };

  const sensor = detectSensor(headerLine, { fileName: filePath });
  if (!sensor) {
    throw new Error(`Could not detect MODIS/VIIRS sensor for ${filePath}.`);
  }
  const sourceMeta = pickArchiveSource(config, sensor, filePath);
  const headers = parseCsv(headerLine)[0].map(normalizeHeader);
  const stats = { rows: 0, kept: 0, skippedInvalid: 0, skippedConfidence: 0, skippedOutside: 0 };
  let batch = [];
  let rowIndex = 0;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (first) {
      first = false;
      continue;
    }
    if (line.trim() === '') continue;
    rowIndex += 1;
    const cells = parseCsv(line)[0] ?? [];
    if (cells.length === 0) continue;
    stats.rows += 1;
    const record = rowToRecord(headers, cells);
    const result = normalizeFirmsRecord(record, {
      sensor,
      sourceMeta,
      regions: config.regions,
      minConfidence: config.firms.modisMinConfidence,
      viirsMinClass: config.firms.viirsMinClass,
      methodVersion: config.methodVersion,
      keepOutsideRegions: true,
      index: rowIndex - 1,
    });
    if (!result.hotspot) {
      if (result.skipped === 'invalid') stats.skippedInvalid += 1;
      else if (result.skipped === 'confidence') stats.skippedConfidence += 1;
      else if (result.skipped === 'outside') stats.skippedOutside += 1;
      continue;
    }
    stats.kept += 1;
    batch.push(result.hotspot);
    if (batch.length >= BATCH_SIZE) {
      await onBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await onBatch(batch);
  }

  return stats;
}

/**
 * Streams FIRMS CSVs into SQLite. Files already imported with the same size and
 * modification time are skipped, so an interrupted import resumes safely.
 */
export async function importCsvFilesToDatabase({
  db,
  inputDir,
  config,
  checkpointFile,
  logger = console,
  maxFiles,
  reset = false,
} = {}) {
  if (!db) throw new Error('A database connection is required.');
  if (!inputDir) throw new Error('An input directory is required.');
  const files = await listCsvFiles(inputDir);
  const checkpoint = reset ? { version: 1, files: {} } : await loadCheckpoint(checkpointFile);
  checkpoint.files = checkpoint.files ?? {};

  let imported = 0;
  let skipped = 0;
  let rows = 0;
  let kept = 0;
  let errors = 0;
  const limit = maxFiles === undefined ? Infinity : Math.max(1, Number(maxFiles));

  for (const filePath of files) {
    if (imported + skipped >= limit) break;
    const relative = path.relative(inputDir, filePath).split(path.sep).join('/');
    const info = await stat(filePath);
    const previous = checkpoint.files[relative];
    if (
      previous?.size === info.size &&
      previous?.mtimeMs === info.mtimeMs
    ) {
      skipped += 1;
      continue;
    }

    try {
      const stats = await importOneFile({
        db,
        filePath,
        config,
        onBatch: async (batch) => {
          await upsertHotspots(db, batch);
        },
      });
      checkpoint.files[relative] = {
        size: info.size,
        mtimeMs: info.mtimeMs,
        ...stats,
        imported_at: new Date().toISOString(),
      };
      imported += 1;
      rows += stats.rows;
      kept += stats.kept;
      await saveCheckpoint(checkpointFile, checkpoint);
      if (imported % 10 === 0 || imported === 1) {
        logger.info?.(
          `Imported ${imported}/${files.length} files · ${rows} rows · ${kept} hotspots kept`,
        );
      }
    } catch (error) {
      errors += 1;
      checkpoint.files[relative] = {
        ...previous,
        error: error.message,
        at: new Date().toISOString(),
      };
      await saveCheckpoint(checkpointFile, checkpoint);
      logger.warn?.(`Import failed for ${relative}: ${error.message}`);
    }
  }

  return {
    files: files.length,
    imported,
    skipped,
    rows,
    kept,
    errors,
    checkpointFile,
  };
}
