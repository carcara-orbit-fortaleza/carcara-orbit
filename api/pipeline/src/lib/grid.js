const EARTH_RADIUS_KM = 6371.0088;
const PALETTE = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14F',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
  '#9C755F',
  '#BAB0AC',
  '#86BCB6',
  '#D37295',
];

export const DEFAULT_GRID_DEGREES = 10;
export const MIN_GRID_DEGREES = 5;
export const MAX_GRID_DEGREES = 60;

export function normalizeGridDegrees(value, fallback = DEFAULT_GRID_DEGREES) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_GRID_DEGREES || number > MAX_GRID_DEGREES) {
    return fallback;
  }
  return Math.round(number * 1000) / 1000;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function token(value, negative, positive) {
  if (value === 0) return '0';
  return `${value < 0 ? negative : positive}${Math.abs(value)}`;
}

function gridId(south, west) {
  return `g_${token(south, 's', 'n')}_${token(west, 'w', 'e')}`;
}

function latLabel(value) {
  if (value === 0) return '0°';
  return `${Math.abs(value)}°${value < 0 ? 'S' : 'N'}`;
}

function lonLabel(value) {
  if (value === 0) return '0°';
  return `${Math.abs(value)}°${value < 0 ? 'W' : 'E'}`;
}

function paletteColor(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

function buildRegion(south, west, size) {
  const north = Math.min(90, rounded(south + size));
  const east = Math.min(180, rounded(west + size));
  const id = gridId(rounded(south), rounded(west));
  const radians = Math.PI / 180;
  const areaKm2 =
    EARTH_RADIUS_KM ** 2 *
    (east - west) *
    radians *
    (Math.sin(north * radians) - Math.sin(south * radians));

  return {
    id,
    name: `${latLabel(rounded(south))} ${lonLabel(rounded(west))}`,
    short: id.replace('g_', '').toUpperCase(),
    biome: 'Grade global',
    scope: 'global',
    area_km2: Math.round(Math.abs(areaKm2)),
    center: [rounded((west + east) / 2), rounded((south + north) / 2)],
    color: paletteColor(id),
    polygon: [
      [rounded(west), rounded(south)],
      [rounded(east), rounded(south)],
      [rounded(east), rounded(north)],
      [rounded(west), rounded(north)],
      [rounded(west), rounded(south)],
    ],
    bounds: [rounded(west), rounded(south), rounded(east), rounded(north)],
  };
}

/**
 * Builds a deterministic world grid. Each cell is a first-class region so the
 * global history can be aggregated without Brazilian biome polygons.
 */
export function buildGridRegions(degrees = DEFAULT_GRID_DEGREES) {
  const size = normalizeGridDegrees(degrees);
  const regions = [];
  const latitudeSteps = Math.ceil(180 / size);
  const longitudeSteps = Math.ceil(360 / size);

  for (let latIndex = 0; latIndex < latitudeSteps; latIndex += 1) {
    const south = rounded(-90 + latIndex * size);
    for (let lonIndex = 0; lonIndex < longitudeSteps; lonIndex += 1) {
      const west = rounded(-180 + lonIndex * size);
      regions.push(buildRegion(south, west, size));
    }
  }

  return regions;
}

/** Fast grid assignment for ingestion; avoids scanning hundreds of polygons. */
export function gridRegionAt(lat, lon, degrees = DEFAULT_GRID_DEGREES) {
  const size = normalizeGridDegrees(degrees);
  const safeLat = Math.min(89.999999, Math.max(-89.999999, Number(lat)));
  const safeLon = Math.min(179.999999, Math.max(-179.999999, Number(lon)));
  const south = rounded(Math.floor((safeLat + 90) / size) * size - 90);
  const west = rounded(Math.floor((safeLon + 180) / size) * size - 180);
  return buildRegion(south, west, size);
}

/**
 * Larger tiles used for NRT requests, where one request per small grid cell
 * would be too expensive.
 */
export function buildWorldTiles(degrees = 30) {
  const size = normalizeGridDegrees(degrees, 30);
  const tiles = [];
  const latitudeSteps = Math.ceil(180 / size);
  const longitudeSteps = Math.ceil(360 / size);

  for (let latIndex = 0; latIndex < latitudeSteps; latIndex += 1) {
    const south = rounded(-90 + latIndex * size);
    for (let lonIndex = 0; lonIndex < longitudeSteps; lonIndex += 1) {
      const west = rounded(-180 + lonIndex * size);
      tiles.push({
        id: gridId(south, west),
        west,
        south,
        east: Math.min(180, rounded(west + size)),
        north: Math.min(90, rounded(south + size)),
      });
    }
  }

  return tiles;
}
