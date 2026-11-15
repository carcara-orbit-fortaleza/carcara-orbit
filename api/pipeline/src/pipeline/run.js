import path from 'node:path';
import { writeJsonAtomic, writeJsonlAtomic, readJsonl } from '../lib/json-store.js';
import { clusterHotspots } from './cluster.js';
import { calibrateFactors } from './calibrate.js';
import { aggregateDataset } from './aggregate.js';
import { detectSensor, normalizeFirmsCsv } from './normalize.js';
import { pickArchiveSource, readCsvInputs } from './firms.js';

function uniqueHotspots(hotspots, regionIds) {
  const byId = new Map();
  for (const hotspot of hotspots) {
    if (!hotspot?.id) continue;
    if (regionIds && !regionIds.has(hotspot.region_id)) continue;
    byId.set(hotspot.id, hotspot);
  }
  return [...byId.values()].sort((a, b) => a.ts_ms - b.ts_ms);
}

export function mergeHotspots(existing, incoming) {
  const byId = new Map();
  for (const hotspot of existing ?? []) {
    if (hotspot?.id) byId.set(hotspot.id, hotspot);
  }
  for (const hotspot of incoming ?? []) {
    if (hotspot?.id) byId.set(hotspot.id, hotspot);
  }
  return [...byId.values()].sort((a, b) => a.ts_ms - b.ts_ms);
}

export async function loadRawHotspots(config) {
  return readJsonl(config.nrt.rawPath, []);
}

export async function runPipelineFromHotspots({
  hotspots,
  config,
  outputDir = config.realDir,
  rawPath = path.join(outputDir, 'raw', 'hotspots.jsonl'),
  writeRaw = true,
  source = 'firms',
  sourceCodes = [],
  warnings = [],
  stats = [],
  generatedAt = new Date().toISOString(),
  currentYear = new Date().getUTCFullYear(),
} = {}) {
  const regionIds = new Set(config.regions.map((region) => region.id));
  const unique = uniqueHotspots(hotspots, regionIds);
  const clusters = clusterHotspots(unique, { radiusKm: 1, hours: 3 });
  const calibration = calibrateFactors(clusters, {
    regions: config.regions,
    calibration: config.calibration,
    methodVersion: config.methodVersion,
  });
  const sourceSet = new Set(sourceCodes.filter(Boolean));
  for (const hotspot of unique) {
    if (hotspot.source) sourceSet.add(hotspot.source);
  }
  const allWarnings = [
    ...warnings,
    ...(calibration.warnings ?? []),
    ...(unique.length === 0 ? ['No hotspots were kept after filtering.'] : []),
  ];

  const dataset = aggregateDataset(clusters, {
    regions: config.regions,
    calibration,
    baseline: config.baseline,
    startYear: 2000,
    currentYear,
    generatedAt,
    methodVersion: config.methodVersion,
    source,
    sourceCodes: [...sourceSet],
    warnings: allWarnings,
    maxMapPoints: config.limits.maxMapPoints,
  });

  if (writeRaw) {
    await writeJsonlAtomic(rawPath, unique);
  }

  await writeJsonAtomic(path.join(outputDir, 'calendario.json'), dataset.calendar);
  await writeJsonAtomic(path.join(outputDir, 'hotspots.geojson'), dataset.hotspots.full);
  await writeJsonAtomic(path.join(outputDir, 'pontos-recentes.json'), dataset.hotspots.map);
  await writeJsonAtomic(path.join(outputDir, 'run-meta.json'), {
    generated_at: generatedAt,
    source,
    source_codes: [...sourceSet],
    current_year: currentYear,
    input_hotspots: unique.length,
    clusters: clusters.length,
    exported_hotspots: dataset.hotspots.total,
    map_hotspots: dataset.hotspots.map.features.length,
    calibration: calibration.summary,
    warnings: [...new Set(allWarnings)],
    input_stats: stats,
  });

  return {
    outputDir,
    rawPath,
    generatedAt,
    inputHotspots: unique.length,
    clusters: clusters.length,
    exportedHotspots: dataset.hotspots.total,
    mapHotspots: dataset.hotspots.map.features.length,
    calibration: calibration.summary,
    warnings: [...new Set(allWarnings)],
    dataset,
  };
}

export async function runPipelineFromCsvFiles({
  inputPath,
  config,
  outputDir = config.realDir,
  currentYear = new Date().getUTCFullYear(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const files = await readCsvInputs(inputPath);
  const hotspots = [];
  const stats = [];
  const warnings = [];
  const sourceCodes = new Set();

  for (const file of files) {
    const sensor = detectSensor(file.text, { fileName: file.path });
    if (!sensor) {
      warnings.push(`Could not detect sensor for ${file.path}; skipped.`);
      continue;
    }
    const sourceMeta = pickArchiveSource(config, sensor, file.path);
    sourceCodes.add(sourceMeta.code);
    const result = normalizeFirmsCsv(file.text, {
      sourceMeta,
      sensor,
      fileName: file.path,
      regions: config.regions,
      minConfidence: config.firms.modisMinConfidence,
      viirsMinClass: config.firms.viirsMinClass,
      methodVersion: config.methodVersion,
    });
    for (const hotspot of result.hotspots) hotspots.push(hotspot);
    stats.push(result.stats);
    if (result.stats.skippedConfidence > 0) {
      warnings.push(`${path.basename(file.path)}: ${result.stats.skippedConfidence} rows skipped by confidence.`);
    }
    if (result.stats.skippedInvalid > 0) {
      warnings.push(`${path.basename(file.path)}: ${result.stats.skippedInvalid} invalid rows skipped.`);
    }
    if (result.stats.skippedOutsideRegions > 0) {
      warnings.push(`${path.basename(file.path)}: ${result.stats.skippedOutsideRegions} rows outside configured regions skipped.`);
    }
  }

  return runPipelineFromHotspots({
    hotspots,
    config,
    outputDir,
    rawPath: path.join(outputDir, 'raw', 'hotspots.jsonl'),
    writeRaw: true,
    source: 'firms-archive',
    sourceCodes: [...sourceCodes],
    warnings,
    stats,
    generatedAt,
    currentYear,
  });
}
