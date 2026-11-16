import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GlobalService } from './global.service.js';

const temp = mkdtempSync(join(tmpdir(), 'carcara-aggregates-'));
const saved = {
  AGGREGATES_DB_PATH: process.env.AGGREGATES_DB_PATH,
  FIRMS_MAP_KEY: process.env.FIRMS_MAP_KEY,
};

beforeAll(() => {
  const path = join(temp, 'aggregates.sqlite');
  process.env.AGGREGATES_DB_PATH = path;
  // Sem a chave, o ano corrente cai no relógio local em vez de chamar o FIRMS.
  delete process.env.FIRMS_MAP_KEY;

  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cells (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, short TEXT, biome TEXT,
      scope TEXT, area_km2 REAL, center TEXT, color TEXT, polygon TEXT,
      bounds TEXT
    );
    CREATE TABLE cell_month (
      cell_id TEXT NOT NULL, year INTEGER NOT NULL, month INTEGER NOT NULL,
      modis INTEGER NOT NULL, viirs INTEGER NOT NULL, hotspots INTEGER NOT NULL,
      factor REAL NOT NULL, harmonized INTEGER NOT NULL,
      PRIMARY KEY (cell_id, year, month)
    );
    CREATE TABLE calibration (
      cell_id TEXT NOT NULL, month INTEGER NOT NULL, factor REAL NOT NULL,
      raw_median REAL, cells INTEGER NOT NULL, region_factor REAL,
      confidence TEXT NOT NULL, PRIMARY KEY (cell_id, month)
    );
    CREATE TABLE recent_points (
      id TEXT PRIMARY KEY, cell_id TEXT NOT NULL, lat REAL NOT NULL,
      lon REAL NOT NULL, date TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      year INTEGER NOT NULL, month INTEGER NOT NULL, sensor TEXT NOT NULL,
      platform TEXT, instrument TEXT, resolution_m INTEGER, confidence INTEGER,
      confidence_class TEXT, brightness_k REAL, frp_mw REAL, daynight TEXT,
      qa_flag TEXT, source TEXT, method_version TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare('INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'g_s30_w60',
    '30°S 60°W',
    'S30_W60',
    'Grade global',
    'global',
    1000,
    JSON.stringify([-45, -15]),
    '#4E79A7',
    JSON.stringify([
      [-60, -30],
      [-30, -30],
      [-30, 0],
      [-60, 0],
      [-60, -30],
    ]),
    JSON.stringify([-60, -30, -30, 0]),
  );
  db.prepare('INSERT INTO cell_month VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'g_s30_w60',
    2025,
    9,
    100,
    46,
    146,
    2,
    123,
  );
  db.prepare('INSERT INTO calibration VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'g_s30_w60',
    9,
    2,
    2,
    12,
    2,
    'high',
  );
  db.prepare(
    `INSERT INTO recent_points VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
  ).run(
    'VIIRS-1',
    'g_s30_w60',
    -17.8,
    -57,
    '2025-09-15',
    Date.UTC(2025, 8, 15, 12),
    2025,
    9,
    'VIIRS',
    'NOAA-20',
    'VIIRS',
    375,
    90,
    'high',
    330.5,
    12.5,
    'D',
    'ok',
    'VIIRS_NOAA20_SP',
    'h1.0',
  );
  const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    years_min: '2000',
    years_max: '2025',
    grid_degrees: '10',
    method_version: 'h1.0',
    calibration_window: '2012-2025',
    source: 'NASA FIRMS / Earthdata',
  })) {
    meta.run(key, value);
  }
  db.close();
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('GlobalService aggregates', () => {
  it('serves every cell with monthly matrices and calibration', async () => {
    const result = await new GlobalService().aggregates();
    expect(result.years[0]).toBe(2000);
    expect(result.years).toContain(2025);
    expect(result.currentYear).toBeGreaterThanOrEqual(2025);
    expect(result.lastCompleteYear).toBe(
      Math.min(2025, result.currentYear - 1),
    );
    expect(result.baselineFrom).toBe(2003);
    expect(result.baselineTo).toBe(Math.min(2025, result.currentYear - 1));
    expect(result.cells).toHaveLength(1);

    const cell = result.cells[0];
    expect(cell.id).toBe('g_s30_w60');
    expect(cell.polygon).toHaveLength(5);
    expect(cell.counts[25][8]).toBe(123);
    expect(cell.modis[25][8]).toBe(100);
    expect(cell.viirs[25][8]).toBe(46);
    expect(cell.factors[8]).toBe(2);
    expect(cell.calibration[8]).toEqual({ factor: 2, confidence: 'high' });
    expect(cell.hotspots).toBe(146);

    const currentIndex = result.years.indexOf(result.currentYear);
    if (currentIndex > 25) {
      expect(cell.counts[currentIndex].every((value) => value === null)).toBe(
        true,
      );
    }
  });

  it('serves recent hotspots from the aggregate sample', () => {
    const result = new GlobalService().hotspots({
      region: 'g_s30_w60',
      from: '2025',
      to: '2025',
      limit: '10',
    });
    expect(result.total).toBe(1);
    expect(result.features[0].geometry.coordinates).toEqual([-57, -17.8]);
    expect(result.features[0].properties.region_name).toBe('30°S 60°W');
    expect(result.features[0].properties.sensor).toBe('VIIRS');
  });
});
