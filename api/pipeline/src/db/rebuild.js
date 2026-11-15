import path from 'node:path';
import { writeJsonAtomic } from '../lib/json-store.js';
import { aggregateDataset, clusterToFeature } from '../pipeline/aggregate.js';
import { calibrateFactorsFromCellCounts } from '../pipeline/calibrate.js';
import { clusterHotspots } from '../pipeline/cluster.js';
import {
  aggregateClusterCounts,
  countClusters,
  countHotspots,
  listHotspotMonths,
  listHotspotSources,
  queryCalibrationCellCounts,
  queryClustersSince,
  queryHotspotsBetween,
  queryRegionClusterCounts,
  replaceClustersForMonth,
} from './database.js';

const BOUNDARY_LOOKBACK_MS = 3 * 60 * 60 * 1000;

function hotspotRow(row) {
  const { imported_at: _importedAt, ...hotspot } = row;
  return hotspot;
}

export async function refreshClusters(
  db,
  { logger = console, months: onlyMonths, onProgress = null } = {},
) {
  const selected = onlyMonths ? new Set(onlyMonths.map((entry) => `${entry.year}-${entry.month}`)) : null;
  const months = listHotspotMonths(db).filter(
    (entry) => !selected || selected.has(`${entry.year}-${entry.month}`),
  );
  let processed = 0;
  let clusters = 0;
  for (const { year, month } of months) {
    const startMs = Date.UTC(year, month - 1, 1) - BOUNDARY_LOOKBACK_MS;
    const endMs = Date.UTC(year, month, 1) + BOUNDARY_LOOKBACK_MS;
    const rows = queryHotspotsBetween(db, startMs, endMs, { onlyRegions: true }).map(hotspotRow);
    const monthly = clusterHotspots(rows).filter(
      (cluster) => cluster.year === year && cluster.month === month,
    );
    replaceClustersForMonth(db, year, month, monthly);
    processed += 1;
    clusters += monthly.length;
    if (processed % 12 === 0) {
      logger.info?.(`Clustered ${processed}/${months.length} months · ${clusters} clusters`);
    }
    await onProgress?.({
      totalMonths: months.length,
      processedMonths: processed,
      clusters,
    });
  }
  return { months: processed, clusters };
}

function buildCoverage(rows) {
  let coverage = null;
  for (const row of rows) {
    const point = { year: row.year, month: row.month };
    if (!coverage) {
      coverage = { start: point, end: point };
      continue;
    }
    if (row.year < coverage.start.year || (row.year === coverage.start.year && row.month < coverage.start.month)) {
      coverage.start = point;
    }
    if (row.year > coverage.end.year || (row.year === coverage.end.year && row.month > coverage.end.month)) {
      coverage.end = point;
    }
  }
  return coverage;
}

function clusterRowToFeature(row, region, calibration, methodVersion) {
  const sensors = JSON.parse(row.sensors ?? '[]');
  const platforms = JSON.parse(row.platforms ?? '[]');
  const ts = new Date(row.ts_ms).toISOString();
  const cluster = {
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    cell_id: row.cell_id,
    date: ts.slice(0, 10),
    ts_utc: ts,
    ts_ms: row.ts_ms,
    year: row.year,
    month: row.month,
    region_id: row.region_id,
    biome: row.biome,
    sensors,
    platforms,
    hotspot_count: row.hotspot_count,
    representative: {
      platform: platforms[0] ?? null,
      instrument: row.instrument,
      resolution_m: row.resolution_m,
      confidence: row.confidence,
      confidence_class: row.confidence_class,
      brightness_k: row.brightness_k,
      frp_mw: row.frp_mw,
      daynight: row.daynight,
      qa_flag: row.qa_flag,
      source: row.source,
    },
  };
  return clusterToFeature(cluster, region, calibration, methodVersion);
}

export function buildDatabaseDatasetInputs(db, config, {
  featureMonths = 24,
  now = new Date(),
} = {}) {
  const countsRows = aggregateClusterCounts(db);
  const counts = {};
  const coverage = {};
  const overlap = {};
  for (const row of countsRows) {
    if (!counts[row.region_id]) counts[row.region_id] = [];
    counts[row.region_id].push(row);
    if (!coverage[row.region_id]) coverage[row.region_id] = buildCoverage([row]);
    else {
      const current = coverage[row.region_id];
      if (row.year < current.start.year || (row.year === current.start.year && row.month < current.start.month)) {
        current.start = { year: row.year, month: row.month };
      }
      if (row.year > current.end.year || (row.year === current.end.year && row.month > current.end.month)) {
        current.end = { year: row.year, month: row.month };
      }
    }
    overlap[row.region_id] = (overlap[row.region_id] ?? 0) + (Number(row.overlap) || 0);
  }

  const startYear = config.calibration?.startYear ?? 2012;
  const endYear = config.calibration?.endYear ?? 2025;
  const cellCounts = queryCalibrationCellCounts(db, startYear, endYear);
  const regionClusterCounts = {};
  for (const row of queryRegionClusterCounts(db, startYear, endYear)) {
    regionClusterCounts[row.region_id] = {
      total: Number(row.total) || 0,
      daytime: Number(row.daytime) || 0,
    };
  }
  const calibration = calibrateFactorsFromCellCounts(cellCounts, {
    regions: config.regions,
    regionClusterCounts,
    calibration: config.calibration,
    methodVersion: config.methodVersion,
  });

  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - featureMonths, 1)).getTime();
  const regionById = new Map(config.regions.map((region) => [region.id, region]));
  const features = [];
  for (const row of queryClustersSince(db, since)) {
    const region = regionById.get(row.region_id);
    if (!region) continue;
    features.push(clusterRowToFeature(row, region, calibration, config.methodVersion));
  }

  return { counts, coverage, overlap, calibration, features };
}

export async function rebuildDatasetFromDatabase({
  db,
  config,
  outputDir = config.realDir,
  featureMonths = 24,
  refresh = true,
  refreshMonths,
  generatedAt = new Date().toISOString(),
  currentYear = new Date().getUTCFullYear(),
  logger = console,
} = {}) {
  if (!db) throw new Error('A database connection is required.');
  const clusterStats = refresh
    ? await refreshClusters(db, { logger, months: refreshMonths })
    : null;
  const precomputed = buildDatabaseDatasetInputs(db, config, { featureMonths });
  const sourceCodes = listHotspotSources(db);
  const warnings = [
    ...precomputed.calibration.warnings,
    `hotspots.geojson contains only the last ${featureMonths} months; the full history is stored in SQLite.`,
  ];
  const dataset = aggregateDataset([], {
    regions: config.regions,
    calibration: precomputed.calibration,
    baseline: config.baseline,
    startYear: 2000,
    currentYear,
    generatedAt,
    methodVersion: config.methodVersion,
    source: 'firms-sqlite',
    sourceCodes,
    warnings,
    maxMapPoints: config.limits.maxMapPoints,
    precomputed,
  });

  await writeJsonAtomic(path.join(outputDir, 'calendario.json'), dataset.calendar);
  await writeJsonAtomic(path.join(outputDir, 'hotspots.geojson'), dataset.hotspots.full);
  await writeJsonAtomic(path.join(outputDir, 'pontos-recentes.json'), dataset.hotspots.map);
  await writeJsonAtomic(path.join(outputDir, 'run-meta.json'), {
    generated_at: generatedAt,
    source: 'firms-sqlite',
    source_codes: sourceCodes,
    current_year: currentYear,
    input_hotspots: countHotspots(db),
    clusters: countClusters(db),
    exported_hotspots: dataset.hotspots.total,
    map_hotspots: dataset.hotspots.map.features.length,
    feature_months: featureMonths,
    refresh_stats: clusterStats,
    calibration: precomputed.calibration.summary,
    warnings: [...new Set(dataset.calendar.meta.warnings)],
  });

  return {
    outputDir,
    generatedAt,
    inputHotspots: countHotspots(db),
    clusters: countClusters(db),
    exportedHotspots: dataset.hotspots.total,
    mapHotspots: dataset.hotspots.map.features.length,
    calibration: precomputed.calibration.summary,
    warnings: dataset.calendar.meta.warnings,
    dataset,
  };
}
