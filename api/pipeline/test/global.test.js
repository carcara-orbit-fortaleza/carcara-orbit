import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { fetchGlobalCurrentHotspots } from '../src/global/current.js';
import { runGlobalIngestion } from '../src/global/ingest.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, '..', 'fixtures');
const modisCsv = await readFile(path.join(fixturesDir, 'modis-sample.csv'), 'utf8');
const modisSize = Buffer.byteLength(modisCsv);
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeFetch(indexUrl) {
  return async (url) => {
    if (url === indexUrl) {
      return new Response(
        [
          'filename,size,updated',
          `modis_2012_Brazil.csv,${modisSize},2026-01-01`,
          `modis_2012_Peru.csv,${modisSize},2026-01-01`,
        ].join('\n'),
        { status: 200 },
      );
    }
    return new Response(modisCsv, { status: 200 });
  };
}

test('runGlobalIngestion downloads all countries, imports and calibrates a world grid', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-global-'));
  try {
    const config = await loadConfig({
      storageDir: temp,
      mode: 'real',
      env: { ...process.env, DATA_SOURCE: 'real', NRT_ENABLED: 'false' },
    });
    config.global.gridDegrees = 30;

    const statusFile = path.join(temp, 'runtime', 'global-status.json');
    const result = await runGlobalIngestion({
      config,
      countries: 'all',
      startYear: 2012,
      endYear: 2012,
      sources: ['MODIS_SP'],
      gridDegrees: 30,
      maxFiles: 2,
      includeCurrent: false,
      allowPartial: true,
      fetchImpl: fakeFetch(config.history.indexUrl),
      logger: silentLogger,
      statusFile,
      generatedAt: '2026-11-15T00:00:00.000Z',
      currentYear: 2026,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.gridDegrees, 30);
    assert.equal(result.regions, 6 * 12);
    assert.ok(result.hotspots > 0);
    assert.ok(result.clusters > 0);
    assert.ok(result.regionsWithData >= 1);
    assert.equal(result.history.downloaded, 2);

    assert.ok(existsSync(config.global.databaseFile));
    const regions = JSON.parse(await readFile(config.global.regionsFile, 'utf8'));
    assert.equal(regions.grid_degrees, 30);
    assert.equal(regions.regions.length, 72);
    assert.ok(regions.regions.some((region) => region.id === 'g_s30_w60'));

    const calibration = JSON.parse(
      await readFile(config.global.calibrationFile, 'utf8'),
    );
    assert.equal(calibration.scope, 'global');
    assert.ok(calibration.factors['g_s30_w60']);

    const status = JSON.parse(await readFile(statusFile, 'utf8'));
    assert.equal(status.running, false);
    assert.equal(status.error, null);
    assert.equal(status.result.hotspots, result.hotspots);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('fetchGlobalCurrentHotspots tiles the world and assigns grid cells', async () => {
  const config = {
    firms: {
      baseUrl: 'https://firms.example',
      mapKey: 'test-key',
      sources: ['MODIS_NRT'],
      timeoutMs: 5000,
      requestDelayMs: 0,
      modisMinConfidence: 30,
      viirsMinClass: 'nominal',
    },
    sourceDefinitions: {
      MODIS_NRT: {
        sensor: 'MODIS',
        code: 'MODIS_NRT',
        resolutionM: 1000,
        instrument: 'MODIS C6.1',
        defaultPlatform: 'Terra/Aqua',
      },
    },
    global: { gridDegrees: 30, nrtTileDegrees: 60 },
    nrt: { days: 2 },
    methodVersion: 'h1.0',
  };

  const result = await fetchGlobalCurrentHotspots({
    config,
    days: 2,
    tileDegrees: 60,
    gridDegrees: 30,
    fetchImpl: async () => new Response(modisCsv, { status: 200 }),
    logger: silentLogger,
  });

  assert.equal(result.tiles, 18);
  assert.equal(result.errors.length, 0);
  assert.ok(result.hotspots.length > 0);
  assert.ok(result.hotspots.every((hotspot) => hotspot.region_id?.startsWith('g_')));
});
