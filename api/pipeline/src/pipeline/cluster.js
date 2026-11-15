import { createHash } from 'node:crypto';
import { gridCellId, haversineKm } from '../lib/geo.js';

const BUCKET_SIZE = 0.01;
const BUCKET = (lat, lon) => `${Math.floor(lat / BUCKET_SIZE)}_${Math.floor(lon / BUCKET_SIZE)}`;

function pickRepresentative(hotspots) {
  return [...hotspots].sort((a, b) => {
    const confidenceDiff = (b.confidence ?? -1) - (a.confidence ?? -1);
    if (confidenceDiff !== 0) return confidenceDiff;
    return a.ts_ms - b.ts_ms;
  })[0];
}

function clusterId(hotspots) {
  const digest = createHash('sha1')
    .update(hotspots.map((hotspot) => hotspot.id).sort().join('|'))
    .digest('hex')
    .slice(0, 12);
  return `CL-${digest}`;
}

export function clusterHotspots(hotspots, { radiusKm = 1, hours = 3 } = {}) {
  const windowMs = hours * 60 * 60 * 1000;
  const sorted = [...hotspots].sort((a, b) => a.ts_ms - b.ts_ms);
  const buckets = new Map();
  const active = [];

  for (const hotspot of sorted) {
    const bucketX = Math.floor(hotspot.lat / BUCKET_SIZE);
    const bucketY = Math.floor(hotspot.lon / BUCKET_SIZE);
    let best = null;
    let bestDistance = Infinity;

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const candidates = buckets.get(`${bucketX + dx}_${bucketY + dy}`) ?? [];
        for (const cluster of candidates) {
          if (hotspot.ts_ms - cluster.startTs > windowMs) continue;
          const distance = haversineKm(hotspot.lat, hotspot.lon, cluster.lat, cluster.lon);
          if (distance <= radiusKm && distance < bestDistance) {
            best = cluster;
            bestDistance = distance;
          }
        }
      }
    }

    if (best) {
      best.hotspots.push(hotspot);
      best.count += 1;
      best.lat += (hotspot.lat - best.lat) / best.count;
      best.lon += (hotspot.lon - best.lon) / best.count;
      best.endTs = Math.max(best.endTs, hotspot.ts_ms);
      best.startTs = Math.min(best.startTs, hotspot.ts_ms);
      best.sensors.add(hotspot.sensor);
      best.platforms.add(hotspot.platform);
    } else {
      const cluster = {
        lat: hotspot.lat,
        lon: hotspot.lon,
        startTs: hotspot.ts_ms,
        endTs: hotspot.ts_ms,
        count: 1,
        sensors: new Set([hotspot.sensor]),
        platforms: new Set([hotspot.platform]),
        hotspots: [hotspot],
      };
      active.push(cluster);
      const key = BUCKET(hotspot.lat, hotspot.lon);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(cluster);
    }
  }

  return active.map((cluster) => {
    const representative = pickRepresentative(cluster.hotspots);
    return {
      id: clusterId(cluster.hotspots),
      lat: cluster.lat,
      lon: cluster.lon,
      cell_id: gridCellId(cluster.lon, cluster.lat),
      start_ts: new Date(cluster.startTs).toISOString(),
      end_ts: new Date(cluster.endTs).toISOString(),
      ts_utc: representative.ts_utc,
      ts_ms: representative.ts_ms,
      date: representative.date,
      year: representative.year,
      month: representative.month,
      region_id: representative.region_id,
      biome: representative.biome,
      sensors: [...cluster.sensors].sort(),
      platforms: [...cluster.platforms].sort(),
      hotspot_count: cluster.count,
      confidence: representative.confidence,
      confidence_class: representative.confidence_class,
      brightness_k: representative.brightness_k,
      frp_mw: representative.frp_mw,
      daynight: representative.daynight,
      qa_flag: representative.qa_flag,
      instrument: representative.instrument,
      resolution_m: representative.resolution_m,
      source: representative.source,
      representative,
    };
  });
}
