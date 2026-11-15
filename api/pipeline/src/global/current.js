import { buildWorldTiles } from '../lib/grid.js';
import { fetchFirmsCsv, waitBetweenRequests } from '../pipeline/firms.js';
import { normalizeFirmsCsv } from '../pipeline/normalize.js';

/**
 * Fetches the current FIRMS window for the whole world. The Area API is called
 * once per coarse tile/source pair, then every detection is assigned to the
 * same grid used by the historical ingestion.
 */
export async function fetchGlobalCurrentHotspots({
  config,
  days = config.nrt.days,
  tileDegrees = config.global?.nrtTileDegrees ?? 30,
  gridDegrees = config.global?.gridDegrees ?? 10,
  fetchImpl = fetch,
  logger = console,
  onProgress = null,
} = {}) {
  if (!config.firms?.mapKey) {
    throw new Error(
      'FIRMS_MAP_KEY is required for the current global NRT ingestion.',
    );
  }

  const tiles = buildWorldTiles(tileDegrees);
  const sources = config.firms.sources ?? [];
  const hotspots = [];
  const errors = [];
  const stats = [];
  const total = tiles.length * sources.length;
  let processed = 0;

  for (const tile of tiles) {
    for (const sourceCode of sources) {
      const sourceMeta = config.sourceDefinitions[sourceCode];
      if (!sourceMeta) {
        errors.push({
          tileId: tile.id,
          source: sourceCode,
          message: 'Unknown FIRMS source in FIRMS_SOURCES.',
        });
        processed += 1;
        continue;
      }

      try {
        const response = await fetchFirmsCsv({
          baseUrl: config.firms.baseUrl,
          mapKey: config.firms.mapKey,
          source: sourceCode,
          bbox: tile,
          dayRange: Math.max(1, Math.min(5, Number(days) || 2)),
          timeoutMs: config.firms.timeoutMs,
          fetchImpl,
        });
        const normalized = normalizeFirmsCsv(response.text, {
          sourceMeta: { ...sourceMeta, code: sourceCode },
          sensor: sourceMeta.sensor,
          fileName: `${tile.id}-${sourceCode}`,
          minConfidence: config.firms.modisMinConfidence,
          viirsMinClass: config.firms.viirsMinClass,
          methodVersion: config.methodVersion,
          gridDegrees,
        });
        hotspots.push(...normalized.hotspots);
        stats.push({
          tileId: tile.id,
          source: sourceCode,
          ...normalized.stats,
        });
        logger.info?.(
          `Global NRT ${tile.id}/${sourceCode}: ${normalized.hotspots.length} hotspots`,
        );
      } catch (error) {
        errors.push({
          tileId: tile.id,
          source: sourceCode,
          message: error.message,
          code: error.code ?? null,
        });
        logger.warn?.(`Global NRT ${tile.id}/${sourceCode} failed: ${error.message}`);
      }

      processed += 1;
      await onProgress?.({
        total,
        processed,
        hotspots: hotspots.length,
        errors: errors.length,
        current: `${tile.id}/${sourceCode}`,
      });
      await waitBetweenRequests(config);
    }
  }

  return { hotspots, errors, stats, tiles: tiles.length, sources };
}
