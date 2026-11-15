import polygonClipping from 'polygon-clipping'
import type { MultiPolygon, Pair } from 'polygon-clipping'
import type { LonLat } from '../types'

const MIN_WEIGHT = 0.002

export function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
  const count = openCount(ring)
  let inside = false
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const crosses = yi > lat !== yj > lat
    if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function polygonAreaKm2(ring: LonLat[]): number {
  const count = openCount(ring)
  if (count < 3) return 0
  let lat = 0
  for (let i = 0; i < count; i++) lat += ring[i][1]
  const mid = (lat / count) * (Math.PI / 180)
  const kx = 111.32 * Math.cos(mid)
  const ky = 110.574
  let sum = 0
  for (let i = 0; i < count; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % count]
    sum += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky)
  }
  return Math.abs(sum / 2)
}

export function regionOverlapWeights(
  polygon: LonLat[],
  regions: { id: string; ring: LonLat[] }[],
): Map<string, number> {
  const drawn = closeRing(polygon)
  const weights = new Map<string, number>()
  if (drawn.length < 4) return weights

  for (const region of regions) {
    const ring = closeRing(region.ring)
    const regionArea = ringArea(ring)
    if (regionArea === 0) {
      weights.set(region.id, 0)
      continue
    }
    const clipped = polygonClipping.intersection([drawn], [ring])
    const weight = Math.min(1, Math.max(0, multiArea(clipped) / regionArea))
    weights.set(region.id, weight < MIN_WEIGHT ? 0 : weight)
  }
  return weights
}

function openCount(ring: LonLat[]): number {
  const count = ring.length
  if (count < 2) return count
  const first = ring[0]
  const last = ring[count - 1]
  return first[0] === last[0] && first[1] === last[1] ? count - 1 : count
}

function closeRing(ring: LonLat[]): Pair[] {
  const count = openCount(ring)
  const closed: Pair[] = []
  for (let i = 0; i < count; i++) closed.push([ring[i][0], ring[i][1]])
  if (closed.length > 0) closed.push([closed[0][0], closed[0][1]])
  return closed
}

function ringArea(ring: Pair[]): number {
  const count = openCount(ring)
  if (count < 3) return 0
  let lat = 0
  for (let i = 0; i < count; i++) lat += ring[i][1]
  const cos = Math.cos((lat / count) * (Math.PI / 180))
  let sum = 0
  for (let i = 0; i < count; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % count]
    sum += x1 * cos * y2 - x2 * cos * y1
  }
  return Math.abs(sum / 2)
}

function multiArea(multi: MultiPolygon): number {
  let total = 0
  for (const polygon of multi) {
    if (polygon.length === 0) continue
    total += ringArea(polygon[0])
    for (let hole = 1; hole < polygon.length; hole++) total -= ringArea(polygon[hole])
  }
  return Math.max(0, total)
}
