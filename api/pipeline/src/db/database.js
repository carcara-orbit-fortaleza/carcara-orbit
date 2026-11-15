import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOTSPOT_COLUMNS = [
  'id',
  'lat',
  'lon',
  'date',
  'ts_ms',
  'year',
  'month',
  'region_id',
  'biome',
  'sensor',
  'platform',
  'instrument',
  'resolution_m',
  'confidence',
  'confidence_class',
  'brightness_k',
  'frp_mw',
  'daynight',
  'qa_flag',
  'source',
  'method_version',
  'imported_at',
];

const CLUSTER_COLUMNS = [
  'id',
  'lat',
  'lon',
  'cell_id',
  'start_ts',
  'end_ts',
  'ts_ms',
  'year',
  'month',
  'region_id',
  'biome',
  'sensors',
  'platforms',
  'hotspot_count',
  'has_modis',
  'has_viirs',
  'confidence',
  'confidence_class',
  'brightness_k',
  'frp_mw',
  'daynight',
  'qa_flag',
  'instrument',
  'resolution_m',
  'source',
];

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function nullish(value) {
  return value === undefined ? null : value;
}

export function openFirmsDatabase({ filePath, reset = false } = {}) {
  if (!filePath) throw new Error('A database file path is required.');
  if (reset) {
    rmSync(filePath, { force: true });
    rmSync(`${filePath}-wal`, { force: true });
    rmSync(`${filePath}-shm`, { force: true });
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS hotspots (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      date TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      region_id TEXT,
      biome TEXT,
      sensor TEXT NOT NULL,
      platform TEXT,
      instrument TEXT,
      resolution_m INTEGER,
      confidence INTEGER,
      confidence_class TEXT,
      brightness_k REAL,
      frp_mw REAL,
      daynight TEXT,
      qa_flag TEXT,
      source TEXT,
      method_version TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hotspots_ts ON hotspots(ts_ms);

    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      cell_id TEXT,
      start_ts TEXT,
      end_ts TEXT,
      ts_ms INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      region_id TEXT,
      biome TEXT,
      sensors TEXT,
      platforms TEXT,
      hotspot_count INTEGER NOT NULL,
      has_modis INTEGER NOT NULL,
      has_viirs INTEGER NOT NULL,
      confidence INTEGER,
      confidence_class TEXT,
      brightness_k REAL,
      frp_mw REAL,
      daynight TEXT,
      qa_flag TEXT,
      instrument TEXT,
      resolution_m INTEGER,
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_clusters_month ON clusters(year, month);
    CREATE INDEX IF NOT EXISTS idx_clusters_region_month ON clusters(region_id, year, month);
    CREATE INDEX IF NOT EXISTS idx_clusters_ts ON clusters(ts_ms);
  `);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  return db;
}

export function closeFirmsDatabase(db) {
  db?.close?.();
}

export function readDatabaseStats(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return {
      hotspots: countHotspots(db),
      clusters: countClusters(db),
    };
  } finally {
    db.close();
  }
}

export function upsertHotspots(db, hotspots, { importedAt = new Date().toISOString() } = {}) {
  if (!hotspots || hotspots.length === 0) return 0;
  const statement = db.prepare(`
    INSERT OR REPLACE INTO hotspots (${HOTSPOT_COLUMNS.join(', ')})
    VALUES (${placeholders(HOTSPOT_COLUMNS.length)})
  `);
  db.exec('BEGIN');
  try {
    for (const hotspot of hotspots) {
      statement.run(
        hotspot.id,
        hotspot.lat,
        hotspot.lon,
        hotspot.date,
        hotspot.ts_ms,
        hotspot.year,
        hotspot.month,
        nullish(hotspot.region_id),
        nullish(hotspot.biome),
        hotspot.sensor,
        nullish(hotspot.platform),
        nullish(hotspot.instrument),
        nullish(hotspot.resolution_m),
        nullish(hotspot.confidence),
        nullish(hotspot.confidence_class),
        nullish(hotspot.brightness_k),
        nullish(hotspot.frp_mw),
        nullish(hotspot.daynight),
        nullish(hotspot.qa_flag),
        nullish(hotspot.source),
        nullish(hotspot.method_version),
        importedAt,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return hotspots.length;
}

export function countHotspots(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM hotspots').get().count;
}

export function countClusters(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM clusters').get().count;
}

export function listHotspotSources(db) {
  return db
    .prepare('SELECT DISTINCT source FROM hotspots WHERE source IS NOT NULL ORDER BY source')
    .all()
    .map((row) => row.source);
}

export function listHotspotMonths(db) {
  return db
    .prepare('SELECT DISTINCT year, month FROM hotspots ORDER BY year ASC, month ASC')
    .all();
}

export function queryHotspotsBetween(db, startMs, endMs, { onlyRegions = false } = {}) {
  return db
    .prepare(
      `SELECT ${HOTSPOT_COLUMNS.join(', ')}
       FROM hotspots
       WHERE ts_ms >= ? AND ts_ms < ?
       ${onlyRegions ? 'AND region_id IS NOT NULL' : ''}
       ORDER BY ts_ms ASC`,
    )
    .all(startMs, endMs);
}

function clusterRowValues(cluster) {
  return [
    cluster.id,
    cluster.lat,
    cluster.lon,
    cluster.cell_id,
    cluster.start_ts,
    cluster.end_ts,
    cluster.ts_ms,
    cluster.year,
    cluster.month,
    cluster.region_id,
    cluster.biome,
    JSON.stringify(cluster.sensors ?? []),
    JSON.stringify(cluster.platforms ?? []),
    cluster.hotspot_count,
    cluster.sensors?.includes('MODIS') ? 1 : 0,
    cluster.sensors?.includes('VIIRS') ? 1 : 0,
    nullish(cluster.representative?.confidence),
    nullish(cluster.representative?.confidence_class),
    nullish(cluster.representative?.brightness_k),
    nullish(cluster.representative?.frp_mw),
    nullish(cluster.representative?.daynight),
    nullish(cluster.representative?.qa_flag),
    nullish(cluster.representative?.instrument),
    nullish(cluster.representative?.resolution_m),
    nullish(cluster.representative?.source),
  ];
}

export function replaceClustersForMonth(db, year, month, clusters) {
  const remove = db.prepare('DELETE FROM clusters WHERE year = ? AND month = ?');
  const statement = db.prepare(`
    INSERT OR REPLACE INTO clusters (${CLUSTER_COLUMNS.join(', ')})
    VALUES (${placeholders(CLUSTER_COLUMNS.length)})
  `);
  db.exec('BEGIN');
  try {
    remove.run(year, month);
    for (const cluster of clusters) {
      statement.run(...clusterRowValues(cluster));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return clusters.length;
}

export function aggregateClusterCounts(db) {
  return db
    .prepare(
      `SELECT region_id,
              year,
              month,
              SUM(has_modis) AS modis,
              SUM(has_viirs) AS viirs,
              SUM(CASE WHEN has_modis = 1 AND has_viirs = 1 THEN 1 ELSE 0 END) AS overlap
       FROM clusters
       WHERE region_id IS NOT NULL
       GROUP BY region_id, year, month
       ORDER BY year ASC, month ASC`,
    )
    .all();
}

export function queryCalibrationCellCounts(db, startYear, endYear) {
  return db
    .prepare(
      `SELECT region_id, cell_id, year, month, daynight,
              SUM(has_modis) AS modis,
              SUM(has_viirs) AS viirs
       FROM clusters
       WHERE year >= ? AND year <= ? AND region_id IS NOT NULL
       GROUP BY region_id, cell_id, year, month, daynight`,
    )
    .all(startYear, endYear);
}

export function queryRegionClusterCounts(db, startYear, endYear) {
  return db
    .prepare(
      `SELECT region_id,
              COUNT(*) AS total,
              SUM(CASE WHEN daynight = 'D' THEN 1 ELSE 0 END) AS daytime
       FROM clusters
       WHERE year >= ? AND year <= ? AND region_id IS NOT NULL
       GROUP BY region_id`,
    )
    .all(startYear, endYear);
}

export function queryClustersSince(db, startMs) {
  return db
    .prepare(
      `SELECT id, lat, lon, cell_id, start_ts, end_ts, ts_ms, year, month,
              region_id, biome, sensors, platforms, hotspot_count,
              confidence, confidence_class, brightness_k, frp_mw, daynight,
              qa_flag, instrument, resolution_m, source
       FROM clusters
       WHERE ts_ms >= ? AND region_id IS NOT NULL
       ORDER BY ts_ms DESC`,
    )
    .all(startMs);
}

export function clearDatabase(db) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM clusters; DELETE FROM hotspots;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
