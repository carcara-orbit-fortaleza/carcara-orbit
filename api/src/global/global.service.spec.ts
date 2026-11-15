import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GlobalService, latestFirmsYear } from './global.service.js';

const temp = mkdtempSync(join(tmpdir(), 'carcara-global-service-'));
const saved = {
  GLOBAL_DB_PATH: process.env.GLOBAL_DB_PATH,
  GLOBAL_REGIONS_FILE: process.env.GLOBAL_REGIONS_FILE,
  GLOBAL_CALIBRATION_FILE: process.env.GLOBAL_CALIBRATION_FILE,
  GLOBAL_STATUS_FILE: process.env.GLOBAL_STATUS_FILE,
};

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('GlobalService', () => {
  beforeAll(() => {
    const dbPath = join(temp, 'global.sqlite');
    const regionsPath = join(temp, 'regions.json');
    const calibrationPath = join(temp, 'calibration.json');
    const statusPath = join(temp, 'status.json');
    process.env.GLOBAL_DB_PATH = dbPath;
    process.env.GLOBAL_REGIONS_FILE = regionsPath;
    process.env.GLOBAL_CALIBRATION_FILE = calibrationPath;
    process.env.GLOBAL_STATUS_FILE = statusPath;

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE hotspots (
        id TEXT PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        ts_ms INTEGER NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        region_id TEXT
      );
      CREATE TABLE clusters (
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
    `);
    const hotspot = db.prepare(
      `INSERT INTO hotspots (id, lat, lon, ts_ms, year, month, region_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    hotspot.run('h1', -17.8, -57.0, Date.UTC(2020, 8, 15), 2020, 9, 'g_s30_w60');
    hotspot.run('h2', -17.9, -57.1, Date.UTC(2021, 8, 15), 2021, 9, 'g_s30_w60');

    const cluster = db.prepare(
      `INSERT INTO clusters (
        id, lat, lon, ts_ms, year, month, region_id, biome, sensors, platforms,
        hotspot_count, has_modis, has_viirs, confidence, confidence_class,
        brightness_k, frp_mw, daynight, qa_flag, instrument, resolution_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    cluster.run(
      'c1', -17.8, -57.0, Date.UTC(2020, 8, 15), 2020, 9, 'g_s30_w60',
      'Grade global', '["MODIS","VIIRS"]', '["Terra","SNPP"]', 14, 10, 4,
      85, 'alta', 330.5, 12.5, 'D', 'ok', 'MODIS', 1000,
    );
    cluster.run(
      'c2', -17.9, -57.1, Date.UTC(2021, 8, 15), 2021, 9, 'g_s30_w60',
      'Grade global', '["MODIS","VIIRS"]', '["Aqua","NOAA-20"]', 7, 5, 2,
      80, 'alta', 331.5, 9.5, 'D', 'ok', 'MODIS', 1000,
    );
    db.close();

    writeJson(regionsPath, {
      scope: 'global',
      grid_degrees: 30,
      generated_at: '2026-11-15T00:00:00.000Z',
      regions: [
        {
          id: 'g_s30_w60',
          name: '30°S 60°W',
          biome: 'Grade global',
          color: '#4E79A7',
          bounds: [-60, -30, -30, 0],
          polygon: [
            [-60, -30],
            [-30, -30],
            [-30, 0],
            [-60, 0],
            [-60, -30],
          ],
        },
      ],
    });
    writeJson(calibrationPath, {
      scope: 'global',
      grid_degrees: 30,
      generated_at: '2026-11-15T00:00:00.000Z',
      method_version: 'h1.0',
      factors: {
        g_s30_w60: {
          '9': { factor: 2, confidence: 'alta' },
        },
      },
      warnings: [],
    });
    writeJson(statusPath, {
      running: false,
      phase: 'done',
      result: { hotspots: 2 },
      error: null,
    });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  });

  function service() {
    return new GlobalService();
  }

  it('reports database, grid and calibration status', () => {
    const status = service().status();
    expect(status.database.available).toBe(true);
    expect(status.database.hotspots).toBe(2);
    expect(status.database.clusters).toBe(2);
    expect(status.regions.gridDegrees).toBe(30);
    expect(status.calibration.available).toBe(true);
    expect(status.ingestion?.phase).toBe('done');
  });

  it('lists grid cells with data', () => {
    const result = service().listRegions();
    expect(result.total).toBe(1);
    expect(result.regions[0].id).toBe('g_s30_w60');
    expect(result.regions[0].hotspots).toBe(2);
  });

  it('builds a harmonized calendar for a grid cell', () => {
    const result = service().calendar({
      region: 'g_s30_w60',
      from: '2020',
      to: '2021',
    });
    expect(result.mode).toBe('global');
    expect(result.region?.id).toBe('g_s30_w60');
    expect(result.counts[0][8]).toBe(12); // 10 MODIS + 4 VIIRS / factor 2
    expect(result.counts[1][8]).toBe(6); // 5 MODIS + 2 VIIRS / factor 2
    expect(result.raw_modis[0][8]).toBe(10);
    expect(result.raw_viirs[0][8]).toBe(4);
    expect(result.meta.grid_degrees).toBe(30);
  });

  it('queries global hotspots and exports CSV', () => {
    const result = service().hotspots({ region: 'g_s30_w60', limit: '10' });
    expect(result.type).toBe('FeatureCollection');
    expect(result.total).toBe(2);
    expect(result.features).toHaveLength(2);
    expect(result.features[0].properties.region_name).toBe('30°S 60°W');

    const csv = service().buildHotspotsCsv({ region: 'g_s30_w60' });
    expect(csv.filename).toContain('global_focos');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain('region_name');
    expect(csv.body.trim().split(/\r?\n/).length).toBe(3);
  });
});

describe('latestFirmsYear', () => {
  it('picks the latest MODIS/VIIRS date from the availability CSV', () => {
    const csv = [
      'data_id,min_date,max_date',
      'MODIS_NRT,2026-09-01,2026-11-15',
      'MODIS_SP,2000-11-01,2026-08-31',
      'VIIRS_NOAA20_SP,2018-04-01,2026-07-31',
      'LANDSAT_NRT,2022-06-20,2027-01-01',
    ].join('\n');
    expect(latestFirmsYear(csv)).toBe(2026);
  });

  it('returns null when no MODIS/VIIRS row has a date', () => {
    expect(latestFirmsYear('data_id,min_date,max_date\nLANDSAT_NRT,,')).toBeNull();
    expect(latestFirmsYear('data_id,min_date,max_date')).toBeNull();
  });
});
