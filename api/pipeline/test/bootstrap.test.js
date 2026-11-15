import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDatabase, runBootstrap } from '../src/bootstrap/bootstrap.js';
import { calibrateFactorsFromCellCounts } from '../src/pipeline/calibrate.js';
import {
  buildCountryPlan,
  downloadCountryCsvs,
  parseCountryIndex,
} from '../src/history/country.js';
import {
  closeFirmsDatabase,
  countHotspots,
  openFirmsDatabase,
} from '../src/db/database.js';
import { importCsvFilesToDatabase } from '../src/db/import.js';
import { loadConfig } from '../src/config.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, '..');
const regions = JSON.parse(await readFile(path.join(apiRoot, 'config', 'regions.json'), 'utf8'));
const pantanal = regions.find((region) => region.id === 'pantanal');

const MODIS_CSV =
  'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,daynight,type\n' +
  '-17.8,-57.0,330,2020-09-15,1330,Terra,MODIS,80,D,0\n';

const VIIRS_CSV =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type\n' +
  '-17.8,-57.0,330,1,1,2020-09-15,1330,N,VIIRS,h,2.0,290,10,D,0\n';

const CURRENT_CSV =
  'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,daynight,type\n' +
  '-17.8,-57.0,330,2026-11-13,1330,Terra,MODIS,80,D,0\n';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    body: new Blob([body]).stream(),
  };
}

function countryIndex(entries) {
  const lines = ['filename,size,updated'];
  for (const [filename, body, year] of entries) {
    lines.push(`${filename},${Buffer.byteLength(body)},2026-10-10 08:57:30`);
  }
  return `${lines.join('\n')}\n`;
}

test('parseCountryIndex and buildCountryPlan filter by country and source', () => {
  const index = countryIndex([
    ['modis_2020_Brazil.csv', MODIS_CSV, 2020],
    ['viirs-snpp_2020_Brazil.csv', VIIRS_CSV, 2020],
    ['viirs-jpss1_2020_Brazil.csv', VIIRS_CSV, 2020],
    ['modis_2020_Argentina.csv', MODIS_CSV, 2020],
    ['modis_2020_all_countries.zip', 'zip', 2020],
  ]);
  const entries = parseCountryIndex(index);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((entry) => entry.sourceCode),
    ['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'MODIS_SP'],
  );

  const plan = buildCountryPlan({ indexText: index, country: 'Brazil', startYear: 2020, endYear: 2020 });
  assert.deepEqual(
    plan.map((entry) => entry.filename),
    ['modis_2020_Brazil.csv', 'viirs-jpss1_2020_Brazil.csv', 'viirs-snpp_2020_Brazil.csv'],
  );
});

test('downloadCountryCsvs downloads files, verifies sizes and skips existing ones', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-country-'));
  try {
    const index = countryIndex([
      ['modis_2020_Brazil.csv', MODIS_CSV, 2020],
      ['viirs-snpp_2020_Brazil.csv', VIIRS_CSV, 2020],
    ]);
    const bodies = new Map([
      ['modis_2020_Brazil.csv', MODIS_CSV],
      ['viirs-snpp_2020_Brazil.csv', VIIRS_CSV],
    ]);
    const fetchImpl = async (url) => {
      const text = String(url);
      if (text.includes('yearly_summary_files.txt')) return response(index);
      const filename = [...bodies.keys()].find((name) => text.endsWith(name));
      if (filename) return response(bodies.get(filename));
      return response('not found', 404);
    };
    const params = {
      country: 'Brazil',
      startYear: 2020,
      endYear: 2020,
      outputDir: path.join(temp, 'raw'),
      checkpointFile: path.join(temp, 'runtime', 'country.json'),
      indexUrl: 'https://example.test/country/yearly_summary_files.txt',
      baseUrl: 'https://example.test/country/',
      requestDelayMs: 0,
      fetchImpl,
      logger: { info() {}, warn() {} },
    };

    const first = await downloadCountryCsvs(params);
    assert.equal(first.downloaded, 2);
    assert.equal(first.skipped, 0);
    assert.equal(
      await readFile(path.join(temp, 'raw', 'MODIS_SP', 'modis_2020_Brazil.csv'), 'utf8'),
      MODIS_CSV,
    );

    const second = await downloadCountryCsvs(params);
    assert.equal(second.downloaded, 0);
    assert.equal(second.skipped, 2);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('importCsvFilesToDatabase streams CSVs, filters and resumes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-import-'));
  const db = openFirmsDatabase({ filePath: path.join(temp, 'db', 'firms.sqlite') });
  try {
    const config = await loadConfig({
      repoRoot: temp,
      storageDir: path.join(temp, 'storage'),
      regions: [pantanal],
      mode: 'real',
      nrtEnabled: false,
      env: { ...process.env, DATA_SOURCE: 'real', NRT_ENABLED: 'false' },
    });
    const csvPath = path.join(temp, 'raw', 'MODIS_SP', 'modis_2020_Brazil.csv');
    await mkdir(path.dirname(csvPath), { recursive: true });
    await writeFile(
      csvPath,
      `${MODIS_CSV}-17.9,-57.1,300,2020-09-16,1330,Terra,MODIS,10,D,0\n`,
      'utf8',
    );

    const checkpointFile = path.join(temp, 'runtime', 'import.json');
    const first = await importCsvFilesToDatabase({
      db,
      inputDir: path.join(temp, 'raw'),
      config,
      checkpointFile,
      logger: { info() {}, warn() {} },
    });
    assert.equal(first.imported, 1);
    assert.equal(first.rows, 2);
    assert.equal(first.kept, 1);
    assert.equal(countHotspots(db), 1);

    const second = await importCsvFilesToDatabase({
      db,
      inputDir: path.join(temp, 'raw'),
      config,
      checkpointFile,
      logger: { info() {}, warn() {} },
    });
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1);
    assert.equal(countHotspots(db), 1);
  } finally {
    closeFirmsDatabase(db);
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('calibrateFactorsFromCellCounts uses aggregated MODIS/VIIRS cell counts', () => {
  const calibration = calibrateFactorsFromCellCounts(
    [
      { region_id: 'pantanal', cell_id: 'a', year: 2020, month: 9, daynight: 'D', modis: 1, viirs: 2 },
      { region_id: 'pantanal', cell_id: 'b', year: 2020, month: 9, daynight: 'D', modis: 1, viirs: 2 },
    ],
    {
      regions: [{ id: 'pantanal', name: 'Pantanal' }],
      regionClusterCounts: { pantanal: { total: 6, daytime: 6 } },
      calibration: {
        startYear: 2012,
        endYear: 2025,
        minCells: 2,
        shrinkageK: 0,
        minFactor: 0.5,
        maxFactor: 4,
      },
    },
  );
  assert.equal(calibration.factors.pantanal[9].factor, 2);
  assert.equal(calibration.summary.pantanal.factor_by_region, 2);
});

test('runBootstrap scrapes country CSVs, uses the API for current data and rebuilds data/real', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-bootstrap-'));
  try {
    const config = await loadConfig({
      repoRoot: temp,
      storageDir: path.join(temp, 'storage'),
      databaseFile: path.join(temp, 'db', 'firms.sqlite'),
      regions: [pantanal],
      mode: 'real',
      nrtEnabled: false,
      firmsMapKey: 'test-key',
      firmsBaseUrl: 'https://example.test',
      env: {
        ...process.env,
        DATA_SOURCE: 'real',
        NRT_ENABLED: 'false',
        FIRMS_SOURCES: 'MODIS_NRT',
      },
    });
    config.history.indexUrl = 'https://example.test/country/yearly_summary_files.txt';
    config.history.baseUrl = 'https://example.test/country/';
    config.firms.requestDelayMs = 0;

    const index = countryIndex([
      ['modis_2020_Brazil.csv', MODIS_CSV, 2020],
      ['viirs-snpp_2020_Brazil.csv', VIIRS_CSV, 2020],
    ]);
    const calls = [];
    const fetchImpl = async (url) => {
      const text = String(url);
      calls.push(text);
      if (text.includes('yearly_summary_files.txt')) return response(index);
      if (text.includes('modis_2020_Brazil.csv')) return response(MODIS_CSV);
      if (text.includes('viirs-snpp_2020_Brazil.csv')) return response(VIIRS_CSV);
      if (text.includes('/api/area/')) return response(CURRENT_CSV);
      return response('not found', 404);
    };

    const before = await inspectDatabase({ config });
    assert.equal(before.empty, true);

    const result = await runBootstrap({
      config,
      country: 'Brazil',
      startYear: 2020,
      endYear: 2020,
      currentDays: 2,
      currentYear: 2026,
      generatedAt: '2026-11-14T12:00:00.000Z',
      featureMonths: 24,
      requestDelayMs: 0,
      fetchImpl,
      logger: { info() {}, warn() {} },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.reason, 'database-empty');
    assert.equal(result.history.downloaded, 2);
    assert.equal(result.imported.imported, 2);
    assert.equal(result.imported.kept, 2);
    assert.equal(result.current.fetched, 1);
    assert.equal(result.database.storedHotspots, 3);
    assert.equal(result.rebuild.inputHotspots, 3);
    assert.equal(result.rebuild.clusters, 2);

    const calendar = JSON.parse(
      await readFile(path.join(config.realDir, 'calendario.json'), 'utf8'),
    );
    assert.equal(calendar.meta.generated_at, '2026-11-14T12:00:00.000Z');
    assert.equal(calendar.metrics.pantanal.total_harmonized, 2);
    const y2020 = calendar.years.indexOf(2020);
    const y2026 = calendar.years.indexOf(2026);
    assert.equal(calendar.calendar.pantanal.counts[y2020][8], 1);
    assert.equal(calendar.calendar.pantanal.counts[y2026][10], 1);

    const geojson = JSON.parse(
      await readFile(path.join(config.realDir, 'hotspots.geojson'), 'utf8'),
    );
    assert.equal(geojson.features.length, 1);

    const runMeta = JSON.parse(
      await readFile(path.join(config.realDir, 'run-meta.json'), 'utf8'),
    );
    assert.equal(runMeta.input_hotspots, 3);
    assert.equal(runMeta.clusters, 2);
    assert.equal(runMeta.feature_months, 24);
    assert.ok(calls.some((url) => url.includes('/api/area/')));

    let secondFetch = 0;
    const second = await runBootstrap({
      config,
      fetchImpl: async () => {
        secondFetch += 1;
        throw new Error('should not fetch when the database is populated');
      },
      logger: { info() {}, warn() {} },
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'database-not-empty');
    assert.equal(secondFetch, 0);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
