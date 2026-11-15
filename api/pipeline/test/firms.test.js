import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAreaUrl, pickArchiveSource } from '../src/pipeline/firms.js';

const sourceConfig = JSON.parse(
  await readFile(new URL('../config/sources.json', import.meta.url), 'utf8'),
);

test('buildAreaUrl keeps bbox commas literal for the FIRMS area API', () => {
  const url = buildAreaUrl({
    baseUrl: 'https://firms.modaps.eosdis.nasa.gov',
    mapKey: 'test-key',
    source: 'MODIS_NRT',
    bbox: { west: -59.2, south: -21, east: -53.8, north: -14.2 },
    dayRange: 1,
  });

  assert.match(url, /\/MODIS_NRT\/-59\.2000,-21\.0000,-53\.8000,-14\.2000\/1$/);
  assert.ok(!url.includes('%2C'));
});

test('pickArchiveSource detects the SNPP archive source from the file path', () => {
  const source = pickArchiveSource(
    { sourceDefinitions: sourceConfig.sources },
    'VIIRS',
    'data/raw/VIIRS_SNPP_SP/2012-01-20_2012-01-24.csv',
  );
  assert.equal(source.code, 'VIIRS_SNPP_SP');
});
