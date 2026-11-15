import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeFirmsDatabase,
  openFirmsDatabase,
  replaceClustersForMonth,
  upsertHotspots,
} from '../../pipeline/src/db/database.js';
import { clusterHotspots } from '../../pipeline/src/pipeline/cluster.js';
import { HotspotsService } from './hotspots.service.js';

const originalDatabaseFile = process.env.FIRMS_DB_PATH;
let temporaryDirectory: string | null = null;

afterEach(async () => {
  if (originalDatabaseFile === undefined) delete process.env.FIRMS_DB_PATH;
  else process.env.FIRMS_DB_PATH = originalDatabaseFile;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    temporaryDirectory = null;
  }
});

function hotspot() {
  return {
    id: 'hotspot-1',
    lat: -17.8,
    lon: -57,
    date: '2020-09-15',
    ts_utc: '2020-09-15T13:30:00.000Z',
    ts_ms: Date.parse('2020-09-15T13:30:00.000Z'),
    year: 2020,
    month: 9,
    region_id: 'pantanal',
    biome: 'Wetland',
    sensor: 'MODIS',
    platform: 'Terra',
    instrument: 'MODIS C6.1',
    resolution_m: 1000,
    confidence: 80,
    confidence_class: 'high',
    brightness_k: 330,
    frp_mw: 10,
    daynight: 'D',
    qa_flag: 'ok',
    source: 'MODIS_SP',
    method_version: 'h1.0',
  };
}

describe('HotspotsService SQLite history', () => {
  it('queries historical clusters from data/db/firms.sqlite', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'carcara-hotspots-'));
    const databaseFile = path.join(temporaryDirectory, 'firms.sqlite');
    process.env.FIRMS_DB_PATH = databaseFile;

    const db = openFirmsDatabase({ filePath: databaseFile });
    try {
      const row = hotspot();
      await upsertHotspots(db, [row]);
      replaceClustersForMonth(db, 2020, 9, clusterHotspots([row]));
    } finally {
      closeFirmsDatabase(db);
    }

    const service = new HotspotsService({
      currentMode: 'real',
      dataset: {
        meta: { method_version: 'h1.0' },
        metrics: { pantanal: { harmonization: { factor_by_region: 1 } } },
      },
      hotspots: { features: [] },
    } as never);

    const result = service.query({ from: '2020', to: '2020', limit: '10' });
    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.features[0].properties.region_id).toBe('pantanal');
    expect(result.features[0].properties.sensors).toEqual(['MODIS']);
  });
});
