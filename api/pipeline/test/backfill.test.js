import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBackfillPlan, runBackfill } from '../src/backfill/backfill.js';

const CSV = 'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,daynight,type\n-17.8,-57.0,330,2001-01-01,1330,Terra,MODIS,80,D,0\n';

test('buildBackfillPlan creates 5-day chunks and clamps sources to their coverage', () => {
  const { plan, sourceRanges, chunkSize } = buildBackfillPlan({
    sources: ['MODIS_SP', 'VIIRS_SNPP_SP'],
    start: '2001-01-01',
    end: '2001-01-10',
    chunkDays: 5,
    today: new Date('2026-11-14T00:00:00Z'),
  });
  assert.equal(chunkSize, 5);
  assert.equal(sourceRanges.MODIS_SP.from, '2001-01-01');
  assert.equal(sourceRanges.VIIRS_SNPP_SP.from, '2012-01-20');
  assert.deepEqual(
    plan.filter((chunk) => chunk.source === 'MODIS_SP').map((chunk) => [chunk.start, chunk.end]),
    [['2001-01-01', '2001-01-05'], ['2001-01-06', '2001-01-10']],
  );
});

test('runBackfill downloads, checkpoints and resumes without refetching', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-backfill-'));
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => CSV,
      };
    };
    const config = {
      repoRoot: temp,
      regions: [],
      firms: { baseUrl: 'https://example.test', mapKey: 'test', timeoutMs: 1000 },
    };
    const params = {
      config,
      sources: ['MODIS_SP'],
      start: '2001-01-01',
      end: '2001-01-10',
      bbox: '-59.2,-21,-53.8,-14.2',
      outputDir: path.join(temp, 'raw'),
      checkpointFile: path.join(temp, 'runtime', 'backfill.json'),
      requestDelayMs: 0,
      fetchImpl,
      logger: { info() {}, warn() {} },
    };

    const dry = await runBackfill({ ...params, dryRun: true });
    assert.equal(dry.planned, 2);
    assert.equal(dry.pending, 2);
    assert.equal(calls.length, 0);

    const first = await runBackfill(params);
    assert.equal(first.planned, 2);
    assert.equal(first.downloaded, 2);
    assert.equal(first.errors, 0);
    assert.equal(first.rows, 2);
    assert.equal(calls.length, 2);
    assert.ok(existsSync(path.join(temp, 'raw', 'MODIS_SP', '2001-01-01_2001-01-05.csv')));
    assert.ok(existsSync(path.join(temp, 'raw', 'MODIS_SP', '2001-01-06_2001-01-10.csv')));

    const checkpoint = JSON.parse(await readFile(path.join(temp, 'runtime', 'backfill.json'), 'utf8'));
    assert.equal(Object.keys(checkpoint.chunks).length, 2);
    assert.ok(Object.values(checkpoint.chunks).every((chunk) => chunk.status === 'done'));

    const second = await runBackfill(params);
    assert.equal(second.downloaded, 0);
    assert.equal(second.skipped, 2);
    assert.equal(calls.length, 2);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('runBackfill records empty chunks and respects maxRequests', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-backfill-empty-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => 'latitude,longitude,brightness\n',
      };
    };
    const config = {
      repoRoot: temp,
      regions: [],
      firms: { baseUrl: 'https://example.test', mapKey: 'test', timeoutMs: 1000 },
    };
    const result = await runBackfill({
      config,
      sources: ['MODIS_SP'],
      start: '2001-01-01',
      end: '2001-01-10',
      bbox: '-59.2,-21,-53.8,-14.2',
      outputDir: path.join(temp, 'raw'),
      checkpointFile: path.join(temp, 'runtime', 'backfill.json'),
      requestDelayMs: 0,
      fetchImpl,
      logger: { info() {}, warn() {} },
    });
    assert.equal(result.attempted, 2);
    assert.equal(result.empty, 2);
    assert.equal(result.downloaded, 0);
    assert.equal(calls, 2);

    const limited = await runBackfill({
      config,
      sources: ['MODIS_SP'],
      start: '2001-01-01',
      end: '2001-01-10',
      bbox: '-59.2,-21,-53.8,-14.2',
      outputDir: path.join(temp, 'raw2'),
      checkpointFile: path.join(temp, 'runtime', 'backfill2.json'),
      requestDelayMs: 0,
      maxRequests: 1,
      fetchImpl,
      logger: { info() {}, warn() {} },
    });
    assert.equal(limited.attempted, 1);
    assert.equal(limited.remaining, 1);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
