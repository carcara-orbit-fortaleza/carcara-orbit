import { regionOverlapWeights } from './geo'
import type { LonLat, RegionSeries } from '../types'

export type RegionWeight = {
  id: string
  name: string
  color: string
  weight: number
}

export type FilteredCalendar = {
  counts: (number | null)[][]
  anomaly: (number | null)[][]
  rawModis: (number | null)[][]
  rawViirs: (number | null)[][]
  weights: RegionWeight[]
  mode: 'region' | 'polygon' | 'empty'
}

const BASELINE_FROM = 2003
const BASELINE_TO = 2025

export function filterCalendar(
  regions: RegionSeries[],
  years: number[],
  polygon: LonLat[] | null,
  regionId: string,
): FilteredCalendar {
  const weights: RegionWeight[] = regions.map((region) => ({
    id: region.id,
    name: region.name,
    color: region.color,
    weight: polygon ? 0 : region.id === regionId ? 1 : 0,
  }))

  if (polygon) {
    try {
      const overlap = regionOverlapWeights(
        polygon,
        regions.map((region) => ({ id: region.id, ring: region.ring })),
      )
      for (const weight of weights) weight.weight = overlap.get(weight.id) ?? 0
    } catch {
      return emptyCalendar(years.length, weights)
    }
  }

  const active = weights.filter((weight) => weight.weight > 0)
  if (active.length === 0) return emptyCalendar(years.length, weights)

  const byId = new Map(regions.map((region) => [region.id, region]))
  const counts = blendMatrix(active, byId, years.length, (region) => region.counts)
  const rawModis = blendMatrix(active, byId, years.length, (region) => region.rawModis)
  const rawViirs = blendMatrix(active, byId, years.length, (region) => region.rawViirs)
  const anomaly = anomalyMatrix(counts, years)

  return {
    counts,
    anomaly,
    rawModis,
    rawViirs,
    weights,
    mode: polygon ? 'polygon' : 'region',
  }
}

function blendMatrix(
  active: RegionWeight[],
  byId: Map<string, RegionSeries>,
  yearCount: number,
  pick: (region: RegionSeries) => (number | null)[][],
): (number | null)[][] {
  return Array.from({ length: yearCount }, (_, yearIndex) =>
    Array.from({ length: 12 }, (_, monthIndex) => {
      const parts = active.map((weight) => ({
        weight: weight.weight,
        value: pick(byId.get(weight.id) as RegionSeries)[yearIndex]?.[monthIndex] ?? null,
      }))
      if (parts.every((part) => part.value === null)) return null
      return parts.reduce((sum, part) => sum + (part.value ?? 0) * part.weight, 0)
    }),
  )
}

function anomalyMatrix(counts: (number | null)[][], years: number[]): (number | null)[][] {
  const anomaly = counts.map((row) => row.map(() => null as number | null))
  for (let month = 0; month < 12; month++) {
    const baseline: number[] = []
    for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
      const year = years[yearIndex]
      const value = counts[yearIndex][month]
      if (year >= BASELINE_FROM && year <= BASELINE_TO && value !== null) baseline.push(value)
    }
    const mean = baseline.length === 0 ? 0 : baseline.reduce((sum, value) => sum + value, 0) / baseline.length
    for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
      const value = counts[yearIndex][month]
      if (value === null) anomaly[yearIndex][month] = null
      else if (mean === 0) anomaly[yearIndex][month] = 0
      else anomaly[yearIndex][month] = ((value - mean) / mean) * 100
    }
  }
  return anomaly
}

function emptyCalendar(yearCount: number, weights: RegionWeight[]): FilteredCalendar {
  const grid = emptyGrid(yearCount)
  return {
    counts: grid,
    anomaly: emptyGrid(yearCount),
    rawModis: emptyGrid(yearCount),
    rawViirs: emptyGrid(yearCount),
    weights,
    mode: 'empty',
  }
}

function emptyGrid(years: number): null[][] {
  return Array.from({ length: years }, () => Array.from({ length: 12 }, () => null))
}
