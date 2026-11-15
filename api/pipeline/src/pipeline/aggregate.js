import { compareMonth, MONTHS_LONG, MONTHS_SHORT, monthLabel } from '../lib/dates.js';
import { featureCollection } from '../lib/geo.js';
import { clamp, linearRegressionSlope, mean, median, percentileRange, round, sum } from '../lib/stats.js';

const numberFormat = new Intl.NumberFormat('en-US');

function formatNumber(value) {
  return numberFormat.format(Math.round(value ?? 0));
}

function signed(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function coverageOf(clusters) {
  if (clusters.length === 0) return null;
  let start = { year: clusters[0].year, month: clusters[0].month };
  let end = { year: clusters[0].year, month: clusters[0].month };
  for (const cluster of clusters) {
    const point = { year: cluster.year, month: cluster.month };
    if (compareMonth(point, start) < 0) start = point;
    if (compareMonth(point, end) > 0) end = point;
  }
  return { start, end };
}

function mergeCoverage(coverages) {
  let merged = null;
  for (const coverage of coverages ?? []) {
    if (!coverage) continue;
    if (!merged) {
      merged = {
        start: { ...coverage.start },
        end: { ...coverage.end },
      };
    } else {
      if (compareMonth(coverage.start, merged.start) < 0) merged.start = { ...coverage.start };
      if (compareMonth(coverage.end, merged.end) > 0) merged.end = { ...coverage.end };
    }
  }
  return merged;
}

function withinCoverage(year, month, coverage) {
  if (!coverage) return false;
  return compareMonth({ year, month }, coverage.start) >= 0 && compareMonth({ year, month }, coverage.end) <= 0;
}

function sensorCounts(clusters) {
  let modis = 0;
  let viirs = 0;
  for (const cluster of clusters) {
    if (cluster.sensors.includes('MODIS')) modis += 1;
    if (cluster.sensors.includes('VIIRS')) viirs += 1;
  }
  return { modis, viirs };
}

function baselineStats(valuesByMonth) {
  const stats = {};
  for (let month = 1; month <= 12; month += 1) {
    const values = (valuesByMonth[month] ?? []).filter((value) => Number.isFinite(value));
    const range = percentileRange(values);
    stats[month] = {
      count: values.length,
      mean: mean(values),
      median: median(values),
      p05: range.p05,
      p95: range.p95,
    };
  }
  return stats;
}

function createEmptyMatrix(yearCount) {
  return Array.from({ length: yearCount }, () => Array.from({ length: 12 }, () => null));
}

function annualSeries(years, counts, baselineStart, baselineEnd, baselineMeanAnnual) {
  return years.map((year, yearIndex) => {
    const values = counts[yearIndex].filter((value) => value !== null);
    const total = values.length > 0 ? sum(values) : null;
    const partial = values.length < 12;
    const anomalyPct = total !== null && baselineMeanAnnual !== null && baselineMeanAnnual > 0
      ? ((total - baselineMeanAnnual) / baselineMeanAnnual) * 100
      : null;
    return {
      year,
      total,
      partial,
      baseline_total: baselineMeanAnnual,
      anomaly_pct: anomalyPct,
    };
  });
}

function climatology(years, counts, baselineStart, baselineEnd) {
  return MONTHS_SHORT.map((label, index) => {
    const month = index + 1;
    const values = [];
    years.forEach((year, yearIndex) => {
      if (year >= baselineStart && year <= baselineEnd) {
        const value = counts[yearIndex][index];
        if (value !== null) values.push(value);
      }
    });
    const range = percentileRange(values);
    return {
      month,
      label,
      mean: mean(values),
      p05: range.p05,
      p95: range.p95,
      max: values.length > 0 ? Math.max(...values) : null,
    };
  });
}

function fireSeason(climatologyData) {
  const means = climatologyData.map((entry) => entry.mean);
  const valid = means.filter((value) => Number.isFinite(value));
  if (valid.length === 0) {
    return { peak_month: null, peak_label: null, start_month: null, end_month: null, active_months: [], peak_mean: null };
  }
  const peakMean = Math.max(...valid);
  const peakIndex = means.indexOf(peakMean);
  const activeMonths = [];
  climatologyData.forEach((entry, index) => {
    if (Number.isFinite(entry.mean) && entry.mean >= peakMean * 0.5) activeMonths.push(index + 1);
  });
  return {
    peak_month: peakIndex + 1,
    peak_label: MONTHS_SHORT[peakIndex],
    start_month: activeMonths[0] ?? null,
    end_month: activeMonths[activeMonths.length - 1] ?? null,
    active_months: activeMonths,
    peak_mean: peakMean,
  };
}

function buildInsights(metrics, season, climatologyData) {
  const insights = [];
  if (metrics.peak_year !== null) {
    insights.push(`Historical peak in ${metrics.peak_year}, with ${formatNumber(metrics.peak_year_total)} harmonized hotspots.`);
  }
  if (season.peak_month) {
    insights.push(`Critical season from ${MONTHS_LONG[(season.start_month ?? season.peak_month) - 1]} to ${MONTHS_LONG[(season.end_month ?? season.peak_month) - 1]}, peaking in ${MONTHS_LONG[season.peak_month - 1]}.`);
  }
  if (metrics.current_year_anomaly_pct !== null && Number.isFinite(metrics.current_year_anomaly_pct)) {
    const direction = metrics.current_year_anomaly_pct >= 0 ? 'above' : 'below';
    insights.push(`${metrics.current_year} (${metrics.current_year_months} months) is ${Math.abs(metrics.current_year_anomaly_pct).toFixed(1)}% ${direction} the ${metrics.baseline_years} average.`);
  } else if (metrics.trend_pct_decade !== null && Number.isFinite(metrics.trend_pct_decade)) {
    insights.push(`${metrics.trend_pct_decade >= 0 ? 'Upward' : 'Downward'} trend of ${Math.abs(metrics.trend_pct_decade).toFixed(1)}% per decade in the harmonized series.`);
  }
  if (insights.length === 0) {
    insights.push('Not enough data yet to generate insights.');
  }
  if (insights.length < 3 && climatologyData.some((entry) => entry.mean !== null)) {
    const peak = climatologyData.reduce((best, entry) => (entry.mean !== null && (!best || entry.mean > best.mean) ? entry : best), null);
    if (peak) {
      insights.push(`The month with the highest historical average is ${MONTHS_LONG[peak.month - 1]}, with ${formatNumber(peak.mean)} hotspots.`);
    }
  }
  return insights.slice(0, 3);
}

function factorFor(calibration, regionId, month) {
  return calibration?.factors?.[regionId]?.[month]?.factor ?? 1;
}

export function clusterToFeature(cluster, region, calibration, methodVersion) {
  const representative = cluster.representative;
  const sensor = cluster.sensors.includes('MODIS') ? 'MODIS' : 'VIIRS';
  const factor = factorFor(calibration, region.id, cluster.month);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [cluster.lon, cluster.lat] },
    properties: {
      id: cluster.id,
      date: cluster.date,
      ts_utc: cluster.ts_utc,
      region_id: region.id,
      biome: region.biome,
      sensor,
      sensors: cluster.sensors,
      platform: representative.platform,
      platforms: cluster.platforms,
      instrument: representative.instrument,
      resolution_m: representative.resolution_m,
      confidence: representative.confidence,
      confidence_class: representative.confidence_class,
      brightness_k: representative.brightness_k,
      frp_mw: representative.frp_mw,
      daynight: representative.daynight,
      qa_flag: representative.qa_flag,
      harmonized_weight: sensor === 'MODIS' ? 1 : round(1 / factor, 3),
      hotspot_count: cluster.hotspot_count,
      method_version: methodVersion,
    },
  };
}

export function aggregateDataset(clusters, {
  regions,
  calibration,
  baseline = {},
  startYear = 2000,
  currentYear = new Date().getUTCFullYear(),
  generatedAt = new Date().toISOString(),
  methodVersion = 'h1.0',
  source = 'firms',
  sourceCodes = [],
  warnings = [],
  maxMapPoints = 2000,
  precomputed = null,
  disclaimer = 'Data derived from NASA FIRMS/Earthdata active fire hotspots. For information only; does not replace official validation.',
  license = 'NASA FIRMS/Earthdata. Attribution required.',
} = {}) {
  const baselineStart = baseline.startYear ?? 2003;
  const baselineEnd = baseline.endYear ?? 2025;
  const globalCoverage = precomputed
    ? mergeCoverage(Object.values(precomputed.coverage ?? {}))
    : coverageOf(clusters);
  const lastYear = Math.max(
    currentYear,
    startYear,
    globalCoverage?.end?.year ?? startYear,
  );
  const years = Array.from({ length: lastYear - startYear + 1 }, (_, index) => startYear + index);
  const baselineYears = Array.from(
    { length: Math.max(0, baselineEnd - baselineStart + 1) },
    (_, index) => baselineStart + index,
  );

  const calendar = {};
  const series = {};
  const metrics = {};
  const insights = {};
  const regionsOut = [];
  const allFeatures = [];
  const allWarnings = [...warnings];

  regions.forEach((region) => {
    const regionClusters = precomputed ? [] : clusters.filter((cluster) => cluster.region_id === region.id);
    const coverage = precomputed?.coverage?.[region.id] ?? coverageOf(regionClusters);
    const counts = createEmptyMatrix(years.length);
    const anomaly = createEmptyMatrix(years.length);
    const rawModis = createEmptyMatrix(years.length);
    const rawViirs = createEmptyMatrix(years.length);
    const viirsShare = createEmptyMatrix(years.length);
    const monthBuckets = new Map();

    if (!precomputed) {
      for (const cluster of regionClusters) {
        const key = `${cluster.year}-${cluster.month}`;
        if (!monthBuckets.has(key)) monthBuckets.set(key, []);
        monthBuckets.get(key).push(cluster);
      }

      years.forEach((year, yearIndex) => {
        for (let month = 1; month <= 12; month += 1) {
          if (!withinCoverage(year, month, coverage)) continue;
          const monthClusters = monthBuckets.get(`${year}-${month}`) ?? [];
          const { modis, viirs } = sensorCounts(monthClusters);
          const factor = factorFor(calibration, region.id, month);
          const harmonized = modis > 0
            ? modis
            : viirs > 0
              ? Math.round(viirs / factor)
              : 0;
          counts[yearIndex][month - 1] = harmonized;
          rawModis[yearIndex][month - 1] = modis;
          rawViirs[yearIndex][month - 1] = viirs;
          viirsShare[yearIndex][month - 1] = modis + viirs > 0
            ? round((viirs / (modis + viirs)) * 100, 1)
            : 0;
        }
      });
    } else {
      years.forEach((year, yearIndex) => {
        for (let month = 1; month <= 12; month += 1) {
          if (!withinCoverage(year, month, coverage)) continue;
          counts[yearIndex][month - 1] = 0;
          rawModis[yearIndex][month - 1] = 0;
          rawViirs[yearIndex][month - 1] = 0;
          viirsShare[yearIndex][month - 1] = 0;
        }
      });
      for (const row of precomputed.counts?.[region.id] ?? []) {
        const yearIndex = years.indexOf(row.year);
        if (yearIndex < 0 || row.month < 1 || row.month > 12) continue;
        const modis = Number(row.modis) || 0;
        const viirs = Number(row.viirs) || 0;
        const factor = factorFor(calibration, region.id, row.month);
        counts[yearIndex][row.month - 1] = modis > 0
          ? modis
          : viirs > 0
            ? Math.round(viirs / factor)
            : 0;
        rawModis[yearIndex][row.month - 1] = modis;
        rawViirs[yearIndex][row.month - 1] = viirs;
        viirsShare[yearIndex][row.month - 1] = modis + viirs > 0
          ? round((viirs / (modis + viirs)) * 100, 1)
          : 0;
      }
    }

    const baselineValues = {};
    for (let month = 1; month <= 12; month += 1) {
      baselineValues[month] = [];
      years.forEach((year, yearIndex) => {
        if (year >= baselineStart && year <= baselineEnd) {
          const value = counts[yearIndex][month - 1];
          if (value !== null) baselineValues[month].push(value);
        }
      });
    }
    const baselineMonthly = baselineStats(baselineValues);

    years.forEach((year, yearIndex) => {
      for (let month = 1; month <= 12; month += 1) {
        const value = counts[yearIndex][month - 1];
        const reference = baselineMonthly[month]?.mean;
        if (value !== null && Number.isFinite(reference) && reference > 0) {
          anomaly[yearIndex][month - 1] = round(((value - reference) / reference) * 100, 1);
        }
      }
    });

    const preliminaryAnnual = annualSeries(years, counts, baselineStart, baselineEnd, null);
    const baselineAnnualValues = preliminaryAnnual
      .filter((entry) => entry.year >= baselineStart && entry.year <= baselineEnd && entry.total !== null && !entry.partial)
      .map((entry) => entry.total);
    const baselineMeanAnnual = mean(baselineAnnualValues);
    const annual = annualSeries(years, counts, baselineStart, baselineEnd, baselineMeanAnnual);

    const lastComplete = annual
      .filter((entry) => entry.year <= baselineEnd && entry.total !== null && !entry.partial)
      .sort((a, b) => b.year - a.year)[0] ?? null;
    const currentYearIndex = years.indexOf(currentYear);
    const currentValues = currentYearIndex >= 0
      ? counts[currentYearIndex].filter((value) => value !== null)
      : [];
    const currentYearMonths = currentValues.length;
    const currentYearTotal = currentValues.length > 0 ? sum(currentValues) : null;
    const baselineSameMonths = currentYearIndex >= 0
      ? counts[currentYearIndex]
        .map((value, monthIndex) => (value !== null ? baselineMonthly[monthIndex + 1]?.mean : null))
        .filter((value) => Number.isFinite(value))
      : [];
    const baselineSameTotal = baselineSameMonths.length > 0 ? sum(baselineSameMonths) : null;
    const currentYearAnomaly = currentYearTotal !== null && baselineSameTotal !== null && baselineSameTotal > 0
      ? ((currentYearTotal - baselineSameTotal) / baselineSameTotal) * 100
      : null;

    const trendPoints = annual.filter(
      (entry) => entry.year >= baselineStart && entry.year <= baselineEnd && entry.total !== null && !entry.partial,
    );
    const trendSlope = linearRegressionSlope(
      trendPoints.map((entry) => entry.year),
      trendPoints.map((entry) => entry.total),
    );
    const trendMean = mean(trendPoints.map((entry) => entry.total));
    const trendPctDecade = trendSlope !== null && trendMean !== null && trendMean > 0
      ? (trendSlope * 10 / trendMean) * 100
      : null;

    const peak = annual
      .filter((entry) => entry.year >= baselineStart && entry.year <= baselineEnd && entry.total !== null && !entry.partial)
      .sort((a, b) => b.total - a.total)[0] ?? null;

    const totalModisRaw = rawModis.flat().filter((value) => value !== null).reduce((acc, value) => acc + value, 0);
    const totalViirsRaw = rawViirs.flat().filter((value) => value !== null).reduce((acc, value) => acc + value, 0);
    const totalRaw = totalModisRaw + totalViirsRaw;
    const calendarTotal = counts.flat().filter((value) => value !== null);
    const yearsCovered = years.filter((year, yearIndex) => counts[yearIndex].some((value) => value !== null)).length;
    const climatologyData = climatology(years, counts, baselineStart, baselineEnd);
    const season = fireSeason(climatologyData);
    const calibrationSummary = calibration?.summary?.[region.id] ?? {};

    const regionMetrics = {
      region_id: region.id,
      region_name: region.name,
      biome: region.biome,
      area_km2: region.area_km2,
      period: coverage
        ? { start: monthLabel(coverage.start.year, coverage.start.month), end: monthLabel(coverage.end.year, coverage.end.month) }
        : { start: null, end: null },
      years_covered: yearsCovered,
      total_harmonized: calendarTotal.length > 0 ? sum(calendarTotal) : 0,
      baseline_mean_annual: baselineMeanAnnual,
      baseline_years: `${baselineStart}–${baselineEnd}`,
      last_complete_year: lastComplete?.year ?? null,
      last_complete_total: lastComplete?.total ?? null,
      last_complete_anomaly_pct: lastComplete?.anomaly_pct ?? null,
      current_year: currentYear,
      current_year_total: currentYearTotal,
      current_year_months: currentYearMonths,
      current_year_anomaly_pct: currentYearAnomaly,
      trend_pct_decade: trendPctDecade,
      trend_window: `${baselineStart}–${baselineEnd}`,
      peak_year: peak?.year ?? null,
      peak_year_total: peak?.total ?? null,
      sensor_mix: {
        modis_pct: totalRaw > 0 ? round((totalModisRaw / totalRaw) * 100, 1) : 0,
        viirs_pct: totalRaw > 0 ? round((totalViirsRaw / totalRaw) * 100, 1) : 0,
        modis_raw: totalModisRaw,
        viirs_raw: totalViirsRaw,
      },
      harmonization: {
        method_version: methodVersion,
        calibration_window: calibration?.calibration_window ?? null,
        factor_by_region: calibrationSummary.factor_by_region ?? 1,
        uncertainty_pct: calibrationSummary.uncertainty_pct ?? 100,
        confidence: calibrationSummary.confidence ?? 'low',
      },
      sensor_coverage: {
        modis: totalModisRaw,
        viirs: totalViirsRaw,
        overlap_clusters: precomputed
          ? precomputed.overlap?.[region.id] ?? 0
          : regionClusters.filter((cluster) => cluster.sensors.length > 1).length,
      },
      coverage: coverage
        ? { start: monthLabel(coverage.start.year, coverage.start.month), end: monthLabel(coverage.end.year, coverage.end.month) }
        : null,
    };

    const hasRegionData = precomputed
      ? (precomputed.counts?.[region.id]?.length ?? 0) > 0
      : regionClusters.length > 0;
    if (!hasRegionData) {
      allWarnings.push(`${region.id}: no hotspots in the input; all calendar cells are null.`);
    }
    if (calibrationSummary.confidence === 'low') {
      allWarnings.push(`${region.id}: low-confidence calibration; treat factors as provisional.`);
    }

    calendar[region.id] = {
      counts,
      anomaly_pct: anomaly,
      raw_modis: rawModis,
      raw_viirs: rawViirs,
      viirs_share_pct: viirsShare,
    };
    series[region.id] = {
      annual,
      climatology: climatologyData,
      season,
    };
    metrics[region.id] = regionMetrics;
    insights[region.id] = buildInsights(regionMetrics, season, climatologyData);
    regionsOut.push(region);

    if (!precomputed) {
      for (const cluster of regionClusters) {
        allFeatures.push(clusterToFeature(cluster, region, calibration, methodVersion));
      }
    }
  });

  if (precomputed?.features) {
    allFeatures.push(...precomputed.features);
  }
  allFeatures.sort((a, b) => String(b.properties.ts_utc).localeCompare(String(a.properties.ts_utc)));
  const mapFeatures = allFeatures.slice(0, maxMapPoints);
  const lastCompleteYear = Math.max(
    ...Object.values(metrics)
      .map((entry) => entry.last_complete_year ?? 0)
      .filter((value) => Number.isFinite(value)),
    0,
  );

  const meta = {
    project: 'Carcará Orbit',
    dataset: 'Harmonized fire activity calendar',
    version: 'firms-1.0',
    generated_at: generatedAt,
    period: globalCoverage
      ? { start: monthLabel(globalCoverage.start.year, globalCoverage.start.month), end: monthLabel(globalCoverage.end.year, globalCoverage.end.month) }
      : { start: null, end: null },
    baseline: `${baselineStart}–${baselineEnd}`,
    last_complete_year: lastCompleteYear || null,
    method_version: methodVersion,
    sensors: ['MODIS C6.1', 'VIIRS 375 m'],
    calibration_window: calibration?.calibration_window ?? null,
    sources: sourceCodes,
    source,
    disclaimer,
    license,
    warnings: [...new Set(allWarnings)],
  };

  return {
    calendar: {
      meta,
      months: MONTHS_SHORT,
      years,
      baseline_years: baselineYears,
      regions: regionsOut,
      calendar,
      series,
      metrics,
      insights,
    },
    hotspots: {
      full: featureCollection(allFeatures),
      map: featureCollection(mapFeatures),
      total: allFeatures.length,
    },
    calibration,
  };
}
