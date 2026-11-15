import { bboxOfPolygon } from '../lib/geo.js';
import { AppError } from '../lib/errors.js';
import { fetchFirmsCsv, waitBetweenRequests } from '../pipeline/firms.js';
import { normalizeFirmsCsv } from '../pipeline/normalize.js';
import { loadRawHotspots, mergeHotspots, runPipelineFromHotspots } from '../pipeline/run.js';

/**
 * Fetches the current (NRT) window through the FIRMS Area API and normalizes it.
 * Historical data should come from the archive CSVs, not from this function.
 */
export async function fetchCurrentHotspots({
  config,
  regionIds = config.nrt.regions,
  days = config.nrt.days,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const hotspots = [];
  const errors = [];
  const stats = [];
  const sourceCodes = new Set();
  const regionSet = new Set(config.regions.map((region) => region.id));
  const selectedRegions = (regionIds ?? []).filter((id) => regionSet.has(id));
  const selectedSet = new Set(selectedRegions);

  for (const regionId of selectedRegions) {
    const region = config.regions.find((item) => item.id === regionId);
    if (!region) continue;
    const bbox = bboxOfPolygon(region.polygon);

    for (const sourceCode of config.firms.sources) {
      const sourceMeta = config.sourceDefinitions[sourceCode];
      if (!sourceMeta) {
        errors.push({ regionId, source: sourceCode, message: 'Unknown FIRMS source in FIRMS_SOURCES.' });
        continue;
      }
      try {
        const response = await fetchFirmsCsv({
          baseUrl: config.firms.baseUrl,
          mapKey: config.firms.mapKey,
          source: sourceCode,
          bbox,
          dayRange: days,
          timeoutMs: config.firms.timeoutMs,
          fetchImpl,
        });
        const normalized = normalizeFirmsCsv(response.text, {
          sourceMeta: { ...sourceMeta, code: sourceCode },
          sensor: sourceMeta.sensor,
          fileName: `${regionId}-${sourceCode}`,
          regions: config.regions,
          minConfidence: config.firms.modisMinConfidence,
          viirsMinClass: config.firms.viirsMinClass,
          methodVersion: config.methodVersion,
        });
        const selectedHotspots = normalized.hotspots.filter((hotspot) => selectedSet.has(hotspot.region_id));
        hotspots.push(...selectedHotspots);
        stats.push({ regionId, source: sourceCode, ...normalized.stats, kept: selectedHotspots.length });
        sourceCodes.add(sourceCode);
        logger.info?.(`NRT ${regionId}/${sourceCode}: ${selectedHotspots.length} hotspots`);
      } catch (error) {
        errors.push({ regionId, source: sourceCode, message: error.message, code: error.code ?? null });
        logger.warn?.(`NRT ${regionId}/${sourceCode} failed: ${error.message}`);
      }
      await waitBetweenRequests(config);
    }
  }

  return { hotspots, errors, stats, sourceCodes };
}

export async function refreshRealData({
  config,
  regionIds = config.nrt.regions,
  days = config.nrt.days,
  fetchImpl = fetch,
  logger = console,
  currentYear = new Date().getUTCFullYear(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const existing = await loadRawHotspots(config);
  const { hotspots: incoming, errors, stats, sourceCodes } = await fetchCurrentHotspots({
    config,
    regionIds,
    days,
    fetchImpl,
    logger,
  });

  const merged = mergeHotspots(existing, incoming);
  if (merged.length === 0) {
    throw new AppError(
      502,
      'NRT_NO_DATA',
      'No NRT hotspots were fetched and no previously stored hotspots exist. Check FIRMS_MAP_KEY and network access.',
      { errors },
    );
  }

  const result = await runPipelineFromHotspots({
    hotspots: merged,
    config,
    outputDir: config.realDir,
    rawPath: config.nrt.rawPath,
    writeRaw: true,
    source: 'firms-nrt',
    sourceCodes: [...sourceCodes],
    warnings: errors.map((error) => `NRT ${error.regionId}/${error.source}: ${error.message}`),
    stats,
    generatedAt,
    currentYear,
  });

  return {
    fetched: incoming.length,
    existing: existing.length,
    total: merged.length,
    errors,
    ...result,
    dataset: undefined,
  };
}
