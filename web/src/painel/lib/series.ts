import { regionOverlapWeights } from './geo'
import type { LonLat, RegionSeries } from '../types'
import { mean } from './stats'

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

export type Baseline = { from: number; to: number }

export function filterCalendar(
  regions: RegionSeries[],
  years: number[],
  polygon: LonLat[] | null,
  regionId: string,
  baseline: Baseline,
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
  const anomaly = anomalyMatrix(counts, years, baseline)

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
      return blendCell(parts)
    }),
  )
}

/**
 * Valor de uma célula ano×mês de um polígono: soma dos valores das regiões ativas vezes o peso.
 * null só quando TODAS as regiões estão sem dado; se só algumas faltam, elas entram como 0
 * (comportamento existente, preservado).
 */
export function blendCell(parts: { weight: number; value: number | null }[]): number | null {
  if (parts.every((part) => part.value === null)) return null
  return parts.reduce((sum, part) => sum + (part.value ?? 0) * part.weight, 0)
}

/** Valores do mês `month` (0..11) nos anos de referência com dado, com os anos de origem. */
export function referenceValues(
  counts: (number | null)[][],
  years: number[],
  reference: Baseline,
  month: number,
): { years: number[]; values: number[] } {
  const usedYears: number[] = []
  const values: number[] = []
  for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
    const year = years[yearIndex]
    const value = counts[yearIndex]?.[month] ?? null
    if (year >= reference.from && year <= reference.to && value !== null) {
      usedYears.push(year)
      values.push(value)
    }
  }
  return { years: usedYears, values }
}

/** Desvio percentual de `value` em relação à média de referência (não-zero). */
export function anomalyPct(value: number, referenceMean: number): number {
  return ((value - referenceMean) / referenceMean) * 100
}

/**
 * Anomalia de cada célula contra a média do mesmo mês nos anos de referência.
 * Sem ano de referência com dado (ou com média zero) a anomalia é null: não existe régua.
 */
export function anomalyMatrix(counts: (number | null)[][], years: number[], reference: Baseline): (number | null)[][] {
  const anomaly = counts.map((row) => row.map(() => null as number | null))
  for (let month = 0; month < 12; month++) {
    const { values } = referenceValues(counts, years, reference, month)
    const monthMean = values.length === 0 ? null : mean(values)
    for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
      const value = counts[yearIndex]?.[month] ?? null
      anomaly[yearIndex][month] = value === null || monthMean === null || monthMean === 0 ? null : anomalyPct(value, monthMean)
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
