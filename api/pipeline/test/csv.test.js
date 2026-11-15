import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, parseCsvObjects, toCsv } from '../src/lib/csv.js';
import { detectSensor, normalizeFirmsCsv } from '../src/pipeline/normalize.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, '..');
const fixturesDir = path.join(apiRoot, 'fixtures');
const regions = JSON.parse(await readFile(path.join(apiRoot, 'config', 'regions.json'), 'utf8'));
const modisCsv = await readFile(path.join(fixturesDir, 'modis-sample.csv'), 'utf8');
const viirsCsv = await readFile(path.join(fixturesDir, 'viirs-sample.csv'), 'utf8');

test('parseCsv handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x,y","q""z"\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,y', 'q"z']]);
});

test('parseCsvObjects normalizes headers and strips BOM', () => {
  const rows = parseCsvObjects('\uFEFFLatitude,Longitude\n-17.8,-57.0\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latitude, '-17.8');
  assert.equal(rows[0].longitude, '-57.0');
});

test('toCsv supports delimiter and BOM', () => {
  const csv = toCsv([['a', 'b'], ['x', 'y']], { delimiter: ';', bom: true });
  assert.equal(csv, '\uFEFFa;b\r\nx;y\r\n');
});

test('detectSensor identifies MODIS and VIIRS headers', () => {
  assert.equal(detectSensor(modisCsv), 'MODIS');
  assert.equal(detectSensor(viirsCsv), 'VIIRS');
});

test('normalizeFirmsCsv keeps valid MODIS rows and assigns regions', () => {
  const result = normalizeFirmsCsv(modisCsv, { regions, sensor: 'MODIS', minConfidence: 30 });
  assert.equal(result.hotspots.length, 8);
  assert.equal(result.stats.skippedConfidence, 0);
  assert.ok(result.hotspots.every((hotspot) => hotspot.sensor === 'MODIS'));
  assert.ok(result.hotspots.every((hotspot) => hotspot.region_id));
  assert.ok(result.hotspots.filter((hotspot) => hotspot.region_id === 'pantanal').length > 0);
});

test('normalizeFirmsCsv keeps valid VIIRS rows and normalizes confidence', () => {
  const result = normalizeFirmsCsv(viirsCsv, { regions, sensor: 'VIIRS', viirsMinClass: 'nominal' });
  assert.equal(result.hotspots.length, 14);
  assert.equal(result.stats.skippedConfidence, 0);
  assert.ok(result.hotspots.every((hotspot) => hotspot.sensor === 'VIIRS'));
  assert.ok(result.hotspots.every((hotspot) => ['low', 'nominal', 'high'].includes(hotspot.confidence_class)));
});

test('normalizeFirmsCsv accepts single-letter VIIRS confidence codes', () => {
  const csv = [
    'latitude,longitude,bright_ti4,acq_date,acq_time,satellite,instrument,confidence,daynight,type',
    '-17.8,-57.0,330,2026-11-10,1330,NOAA-20,VIIRS,n,D,0',
    '-17.81,-57.01,330,2026-11-10,1330,NOAA-20,VIIRS,h,D,0',
    '-17.82,-57.02,330,2026-11-10,1330,NOAA-20,VIIRS,l,D,0',
  ].join('\n');
  const result = normalizeFirmsCsv(csv, { regions, sensor: 'VIIRS', viirsMinClass: 'nominal' });
  assert.equal(result.hotspots.length, 2);
  assert.equal(result.stats.skippedConfidence, 1);
  assert.deepEqual(result.hotspots.map((hotspot) => hotspot.confidence_class).sort(), ['high', 'nominal']);
});

test('normalizeFirmsCsv filters low-confidence MODIS rows', () => {
  const csv = 'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,daynight,type\n-17.8,-57.0,330,2020-09-15,1330,Terra,MODIS,10,D,0\n';
  const result = normalizeFirmsCsv(csv, { regions, sensor: 'MODIS', minConfidence: 30 });
  assert.equal(result.hotspots.length, 0);
  assert.equal(result.stats.skippedConfidence, 1);
});

test('normalizeFirmsCsv filters rows outside configured regions', () => {
  const csv = 'latitude,longitude,brightness,acq_date,acq_time,satellite,instrument,confidence,daynight,type\n10.0,10.0,330,2020-09-15,1330,Terra,MODIS,90,D,0\n';
  const result = normalizeFirmsCsv(csv, { regions, sensor: 'MODIS', minConfidence: 30 });
  assert.equal(result.hotspots.length, 0);
  assert.equal(result.stats.skippedOutsideRegions, 1);
});
