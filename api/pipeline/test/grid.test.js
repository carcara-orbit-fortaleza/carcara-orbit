import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGridRegions,
  buildWorldTiles,
  gridRegionAt,
  normalizeGridDegrees,
} from '../src/lib/grid.js';

test('buildGridRegions covers the world without duplicate ids', () => {
  const regions = buildGridRegions(10);
  assert.equal(regions.length, 18 * 36);
  assert.equal(new Set(regions.map((region) => region.id)).size, regions.length);
  assert.ok(regions.every((region) => region.scope === 'global'));
  assert.ok(regions.every((region) => region.polygon.length === 5));
});

test('gridRegionAt resolves boundaries and coordinates', () => {
  const cell = gridRegionAt(-17.8, -57.0, 10);
  assert.equal(cell.id, 'g_s20_w60');
  assert.deepEqual(cell.bounds, [-60, -20, -50, -10]);
  assert.equal(gridRegionAt(0, 0, 10).id, 'g_0_0');
  assert.equal(gridRegionAt(89.9, 179.9, 10).id, 'g_n80_e170');
  assert.equal(gridRegionAt(-89.9, -179.9, 10).id, 'g_s90_w180');
});

test('normalizeGridDegrees rejects unsafe values', () => {
  assert.equal(normalizeGridDegrees(10), 10);
  assert.equal(normalizeGridDegrees('30'), 30);
  assert.equal(normalizeGridDegrees(1), 10);
  assert.equal(normalizeGridDegrees(500), 10);
});

test('buildWorldTiles creates coarse NRT tiles', () => {
  const tiles = buildWorldTiles(30);
  assert.equal(tiles.length, 6 * 12);
  assert.deepEqual(tiles[0], {
    id: 'g_s90_w180',
    west: -180,
    south: -90,
    east: -150,
    north: -60,
  });
  assert.deepEqual(tiles.at(-1), {
    id: 'g_n60_e150',
    west: 150,
    south: 60,
    east: 180,
    north: 90,
  });
});
