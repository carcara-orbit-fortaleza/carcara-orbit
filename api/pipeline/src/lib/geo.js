const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function ringOf(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return [];
  return Array.isArray(polygon[0][0]) ? polygon[0] : polygon;
}

function pointOnSegment([x, y], [x1, y1], [x2, y2]) {
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-12) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < 0) return false;
  const squaredLength = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  return dot <= squaredLength;
}

export function pointInPolygon([lon, lat], polygon) {
  const ring = ringOf(polygon);
  if (ring.length < 3) return false;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    if (pointOnSegment([lon, lat], [xi, yi], [xj, yj])) return true;

    const intersects = yi > lat !== yj > lat;
    if (intersects) {
      const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lon < x) inside = !inside;
    }
  }

  return inside;
}

export function bboxOfPolygon(polygon) {
  const ring = ringOf(polygon);
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  return {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats),
  };
}

export function polygonCentroid(polygon) {
  const ring = ringOf(polygon);
  if (ring.length === 0) return [0, 0];
  const sum = ring.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

export function gridCellId(lon, lat, size = 0.1) {
  const x = Math.round(lon / size);
  const y = Math.round(lat / size);
  return `${x}_${y}`;
}

export function assignRegion(hotspot, regions) {
  const candidates = regions.filter((region) => pointInPolygon([hotspot.lon, hotspot.lat], region.polygon));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.area_km2 ?? Infinity) - (b.area_km2 ?? Infinity));
  return candidates[0];
}

export function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

export function polygonFeature(region) {
  return {
    type: 'Feature',
    properties: {
      id: region.id,
      name: region.name,
      short: region.short,
      biome: region.biome,
      area_km2: region.area_km2,
      color: region.color,
    },
    geometry: { type: 'Polygon', coordinates: [region.polygon] },
  };
}
