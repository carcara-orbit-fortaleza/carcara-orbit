import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateFactors } from '../src/pipeline/calibrate.js';
import { clusterHotspots } from '../src/pipeline/cluster.js';
import { runPipelineFromCsvFiles } from '../src/pipeline/run.js';
import { loadConfig } from '../src/config.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, '..');
const fixturesDir = path.join(apiRoot, 'fixtures');
const regions = JSON.parse(await readFile(path.join(apiRoot, 'config', 'regions.json'), 'utf8'));

function cluster({ cell, sensors, region = 'pantanal', month = 9, year = 2020 }) {
  return {
    cell_id: cell,
    sensors,
    region_id: region,
    month,
    year,
    daynight: 'D',
  };
}

test('calibrateFactors computes the median VIIRS/MODIS ratio per cell', () => {
  const clusters = [
    cluster({ cell: 'a', sensors: ['MODIS'] }),
    cluster({ cell: 'a', sensors: ['VIIRS'] }),
    cluster({ cell: 'a', sensors: ['VIIRS'] }),
    cluster({ cell: 'a', sensors: ['VIIRS'] }),
    cluster({ cell: 'b', sensors: ['MODIS'] }),
    cluster({ cell: 'b', sensors: ['VIIRS'] }),
  ];
  const calibration = calibrateFactors(clusters, {
    regions: [{ id: 'pantanal', name: 'Pantanal' }],
    calibration: {
      startYear: 2012,
      endYear: 2025,
      minCells: 2,
      shrinkageK: 0,
      minFactor: 0.5,
      maxFactor: 4,
    },
  });

  assert.equal(calibration.factors.pantanal[9].factor, 2);
  assert.equal(calibration.factors.pantanal[9].cells, 2);
  assert.equal(calibration.summary.pantanal.factor_by_region, 2);
});

test('calibrateFactors falls back to factor 1 without overlap', () => {
  const calibration = calibrateFactors([], {
    regions: [{ id: 'pantanal', name: 'Pantanal' }],
    calibration: { startYear: 2012, endYear: 2025, minCells: 30, shrinkageK: 20, minFactor: 0.5, maxFactor: 4 },
  });
  assert.equal(calibration.factors.pantanal[1].factor, 1);
  assert.equal(calibration.factors.pantanal[1].confidence, 'baixa');
});

test('clusterHotspots merges nearby detections and keeps far ones separate', () => {
  const base = {
    sensor: 'MODIS',
    platform: 'Terra',
    region_id: 'pantanal',
    biome: 'Área úmida',
    confidence: 80,
    confidence_class: 'alta',
    brightness_k: 330,
    frp_mw: 10,
    daynight: 'D',
    qa_flag: 'ok',
    instrument: 'MODIS',
    resolution_m: 1000,
    source: 'MODIS_NRT',
    date: '2020-09-15',
    ts_utc: '2020-09-15T13:30:00.000Z',
    ts_ms: Date.parse('2020-09-15T13:30:00.000Z'),
    year: 2020,
    month: 9,
  };
  const hotspots = [
    { ...base, id: 'a', lat: -17.8, lon: -57.0 },
    { ...base, id: 'b', lat: -17.8005, lon: -57.0005 },
    { ...base, id: 'c', lat: -17.85, lon: -57.1 },
  ];
  const clusters = clusterHotspots(hotspots);
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find((item) => item.hotspot_count === 2)?.sensors.includes('MODIS'), true);
});

test('runPipelineFromCsvFiles writes a complete real dataset', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'carcara-pipeline-'));
  try {
    const config = await loadConfig({
      storageDir: temp,
      mode: 'real',
      nrtEnabled: false,
      env: { ...process.env, DATA_SOURCE: 'real', NRT_ENABLED: 'false' },
    });
    const result = await runPipelineFromCsvFiles({
      inputPath: fixturesDir,
      config,
      outputDir: temp,
      generatedAt: '2026-11-14T12:00:00.000Z',
      currentYear: 2026,
    });

    assert.ok(result.inputHotspots > 0);
    assert.ok(result.clusters > 0);
    assert.ok(result.exportedHotspots > 0);
    assert.ok(result.calibration.pantanal.factor_by_region > 0);

    const calendar = JSON.parse(await readFile(path.join(temp, 'calendario.json'), 'utf8'));
    assert.equal(calendar.meta.method_version, 'h1.0');
    assert.equal(calendar.meta.generated_at, '2026-11-14T12:00:00.000Z');
    assert.ok(calendar.metrics.pantanal.total_harmonized > 0);
    assert.equal(calendar.calendar.pantanal.counts.length, calendar.years.length);
    assert.equal(calendar.calendar.pantanal.counts[0].length, 12);

    const y2020 = calendar.years.indexOf(2020);
    const y2024 = calendar.years.indexOf(2024);
    const y2026 = calendar.years.indexOf(2026);
    assert.equal(calendar.calendar.pantanal.counts[y2020][8], 2);
    assert.equal(calendar.calendar.pantanal.raw_modis[y2020][8], 2);
    assert.equal(calendar.calendar.pantanal.raw_viirs[y2020][8], 2);
    assert.equal(calendar.calendar.pantanal.counts[y2024][7], 1);
    assert.equal(calendar.calendar.pantanal.raw_modis[y2024][7], 1);
    assert.equal(calendar.calendar.pantanal.raw_viirs[y2024][7], 2);
    assert.equal(calendar.calendar.pantanal.counts[y2026][9], 1);
    assert.equal(calendar.calendar.pantanal.raw_modis[y2026][9], 1);
    assert.equal(calendar.calendar.pantanal.raw_viirs[y2026][9], 1);

    const points = JSON.parse(await readFile(path.join(temp, 'hotspots.geojson'), 'utf8'));
    assert.equal(points.type, 'FeatureCollection');
    assert.equal(points.features.length, result.clusters);
    assert.ok(points.features.every((feature) => feature.properties.region_id));

    const map = JSON.parse(await readFile(path.join(temp, 'pontos-recentes.json'), 'utf8'));
    assert.ok(map.features.length > 0);
    assert.ok(map.features.length <= 2000);

    const runMeta = JSON.parse(await readFile(path.join(temp, 'run-meta.json'), 'utf8'));
    assert.equal(runMeta.input_hotspots, result.inputHotspots);
    assert.equal(runMeta.clusters, result.clusters);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
