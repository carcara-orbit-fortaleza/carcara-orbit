import { bootstrapMedianCI, clamp, median } from '../lib/stats.js';

function monthlyCellRatios(clusters) {
  const cells = new Map();
  for (const cluster of clusters) {
    if (!cluster.region_id || !cluster.cell_id) continue;
    if (!cells.has(cluster.cell_id)) cells.set(cluster.cell_id, { modis: 0, viirs: 0 });
    const cell = cells.get(cluster.cell_id);
    if (cluster.sensors.includes('MODIS')) cell.modis += 1;
    if (cluster.sensors.includes('VIIRS')) cell.viirs += 1;
  }

  return [...cells.values()]
    .filter((cell) => cell.modis > 0 && cell.viirs > 0)
    .map((cell) => cell.viirs / cell.modis);
}

function computeCalibration({
  regions,
  ratiosByMonth,
  modes,
  calibration = {},
  methodVersion = 'h1.0',
}) {
  const startYear = calibration.startYear ?? 2012;
  const endYear = calibration.endYear ?? 2025;
  const minCells = calibration.minCells ?? 30;
  const shrinkageK = calibration.shrinkageK ?? 20;
  const minFactor = calibration.minFactor ?? 0.5;
  const maxFactor = calibration.maxFactor ?? 4.0;

  const factors = {};
  const regionFactors = {};
  const summary = {};
  const warnings = [];

  regions.forEach((region, regionIndex) => {
    const monthlyRatios = ratiosByMonth[region.id] ?? {};
    const calibrationMode = modes[region.id] ?? 'all';
    const allRatios = Object.values(monthlyRatios).flat();
    const regionFactor = median(allRatios) ?? 1.0;
    regionFactors[region.id] = {
      factor: clamp(regionFactor, minFactor, maxFactor),
      cells: allRatios.length,
      calibrationMode,
    };

    factors[region.id] = {};
    let monthsWithRatios = 0;
    let highConfidenceMonths = 0;
    let mediumOrBetterMonths = 0;

    for (let month = 1; month <= 12; month += 1) {
      const ratios = monthlyRatios[month] ?? [];
      const rawMedian = median(ratios);
      const weight = ratios.length / (ratios.length + shrinkageK);
      const shrunk = rawMedian === null
        ? regionFactors[region.id].factor
        : weight * rawMedian + (1 - weight) * regionFactors[region.id].factor;
      const factor = clamp(shrunk, minFactor, maxFactor);
      const ci = bootstrapMedianCI(ratios, {
        resamples: 200,
        seed: 20261114 + regionIndex * 131 + month,
      });
      const uncertaintyPct = ratios.length > 0 ? ci.uncertaintyPct : 100;
      const confidence = ratios.length >= minCells && uncertaintyPct <= 20
        ? 'alta'
        : ratios.length >= minCells
          ? 'média'
          : 'baixa';

      if (ratios.length > 0) monthsWithRatios += 1;
      if (confidence === 'alta') highConfidenceMonths += 1;
      if (confidence !== 'baixa') mediumOrBetterMonths += 1;

      factors[region.id][month] = {
        factor: Math.round(factor * 1000) / 1000,
        raw_median: rawMedian === null ? null : Math.round(rawMedian * 1000) / 1000,
        region_factor: Math.round(regionFactors[region.id].factor * 1000) / 1000,
        cells: ratios.length,
        uncertainty_pct: Math.round(uncertaintyPct * 10) / 10,
        confidence,
        calibration_mode: calibrationMode,
      };
    }

    const overallConfidence = highConfidenceMonths >= 8
      ? 'alta'
      : mediumOrBetterMonths >= 6
        ? 'média'
        : 'baixa';
    const monthlyUncertainties = Object.values(factors[region.id])
      .map((entry) => entry.uncertainty_pct)
      .filter((value) => Number.isFinite(value));
    const monthlyFactors = Object.values(factors[region.id]).map((entry) => entry.factor);

    summary[region.id] = {
      calibration_mode: calibrationMode,
      months_with_ratios: monthsWithRatios,
      cells: allRatios.length,
      factor_by_region: regionFactors[region.id].factor,
      factor_median: median(monthlyFactors),
      uncertainty_pct: median(monthlyUncertainties),
      confidence: overallConfidence,
    };

    if (allRatios.length === 0) {
      warnings.push(`No overlap cells with MODIS+VIIRS for ${region.id}; calibration fell back to factor 1.0.`);
    } else if (allRatios.length < minCells) {
      warnings.push(`${region.id}: only ${allRatios.length} overlap cells; factors are low-confidence.`);
    }
  });

  return {
    method_version: methodVersion,
    calibration_window: `${startYear}–${endYear}`,
    min_cells: minCells,
    shrinkage_k: shrinkageK,
    factor_range: [minFactor, maxFactor],
    factors,
    region_factors: regionFactors,
    summary,
    warnings,
  };
}

export function calibrateFactors(clusters, {
  regions,
  calibration = {},
  methodVersion = 'h1.0',
} = {}) {
  const startYear = calibration.startYear ?? 2012;
  const endYear = calibration.endYear ?? 2025;
  const minCells = calibration.minCells ?? 30;
  const ratiosByMonth = {};
  const modes = {};

  regions.forEach((region) => {
    const regionClusters = clusters.filter(
      (cluster) => cluster.region_id === region.id && cluster.year >= startYear && cluster.year <= endYear,
    );
    const daytime = regionClusters.filter((cluster) => cluster.daynight === 'D');
    const useDaytime = daytime.length >= minCells || (daytime.length > 0 && daytime.length === regionClusters.length);
    const base = useDaytime ? daytime : regionClusters;
    modes[region.id] = useDaytime ? 'daytime' : 'all';
    ratiosByMonth[region.id] = {};
    for (let month = 1; month <= 12; month += 1) {
      ratiosByMonth[region.id][month] = monthlyCellRatios(base.filter((cluster) => cluster.month === month));
    }
  });

  return computeCalibration({ regions, ratiosByMonth, modes, calibration, methodVersion });
}

/**
 * Calibration for the SQLite path. Instead of loading every cluster, the
 * database aggregates counts per cell/month/daynight first.
 */
export function calibrateFactorsFromCellCounts(cellCounts, {
  regions,
  regionClusterCounts = {},
  calibration = {},
  methodVersion = 'h1.0',
} = {}) {
  const startYear = calibration.startYear ?? 2012;
  const endYear = calibration.endYear ?? 2025;
  const minCells = calibration.minCells ?? 30;
  const ratiosByMonth = {};
  const modes = {};

  for (const region of regions) {
    const rows = cellCounts.filter(
      (row) => row.region_id === region.id && row.year >= startYear && row.year <= endYear,
    );
    const counts = regionClusterCounts[region.id] ?? {};
    const total = Number(counts.total) || 0;
    const daytime = Number(counts.daytime) || 0;
    const useDaytime = daytime >= minCells || (daytime > 0 && daytime === total);
    modes[region.id] = useDaytime ? 'daytime' : 'all';
    ratiosByMonth[region.id] = {};

    for (let month = 1; month <= 12; month += 1) {
      const cells = new Map();
      for (const row of rows) {
        if (row.month !== month) continue;
        if (useDaytime && row.daynight !== 'D') continue;
        if (!cells.has(row.cell_id)) cells.set(row.cell_id, { modis: 0, viirs: 0 });
        const cell = cells.get(row.cell_id);
        cell.modis += Number(row.modis) || 0;
        cell.viirs += Number(row.viirs) || 0;
      }
      ratiosByMonth[region.id][month] = [...cells.values()]
        .filter((cell) => cell.modis > 0 && cell.viirs > 0)
        .map((cell) => cell.viirs / cell.modis);
    }
  }

  return computeCalibration({ regions, ratiosByMonth, modes, calibration, methodVersion });
}
