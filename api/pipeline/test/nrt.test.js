import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { refreshRealData } from '../src/nrt/refresh.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pipelineRoot = path.resolve(testDir, '..');
const fixturesDir = path.join(pipelineRoot, 'fixtures');
const modisCsv = await readFile(path.join(fixturesDir, 'modis-sample.csv'), 'utf8');
const viirsCsv = await readFile(path.join(fixturesDir, 'viirs-sample.csv'), 'utf8');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeFirmsFetch(url) {
  const text = url.includes('MODIS_NRT') ? modisCsv : viirsCsv;
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => text,
  });
}

test('refreshRealData fetches FIRMS-like CSVs and builds data/real in a temp directory', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-pipeline-nrt-'));
  try {
    const config = await loadConfig({
      storageDir: temp,
      mode: 'real',
      nrtEnabled: false,
      nrtRegions: ['pantanal'],
      nrtSources: ['MODIS_NRT', 'VIIRS_NOAA20_NRT'],
      firmsMapKey: 'test-key',
      env: { ...process.env, DATA_SOURCE: 'real', NRT_ENABLED: 'false' },
    });

    const result = await refreshRealData({
      config,
      regionIds: ['pantanal'],
      days: 2,
      fetchImpl: fakeFirmsFetch,
      logger: silentLogger,
      generatedAt: '2026-11-14T12:00:00.000Z',
      currentYear: 2026,
    });

    assert.equal(result.errors.length, 0);
    assert.ok(result.fetched > 0);
    assert.ok(result.total > 0);
    assert.ok(result.clusters > 0);

    const calendar = JSON.parse(await readFile(path.join(config.realDir, 'calendario.json'), 'utf8'));
    assert.equal(calendar.meta.source, 'firms-nrt');
    assert.equal(calendar.meta.generated_at, '2026-11-14T12:00:00.000Z');
    assert.ok(calendar.metrics.pantanal.total_harmonized > 0);
    assert.ok(calendar.metrics.pantanal.harmonization.factor_by_region > 0);

    const raw = await readFile(config.nrt.rawPath, 'utf8');
    assert.ok(raw.trim().split(/\r?\n/).length > 0);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
