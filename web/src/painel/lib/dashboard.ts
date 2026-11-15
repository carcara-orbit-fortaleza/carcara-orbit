import { formatShare, formatSignedPercent } from './format'
import type { FilteredCalendar, RegionWeight } from './series'
import type { AnnualPoint, ClimatologyMonth, RegionSeries } from '../types'

export type Dashboard = {
  name: string
  biome: string
  insights: string[]
  confidence: string
  factor: number
  uncertainty: number
  currentYear: number
  currentTotal: number
  currentAnomaly: number
  peakYear: number
  peakTotal: number
  trend: number
  trendWindow: string
  modisPct: number
  viirsPct: number
  modisRaw: number
  viirsRaw: number
  climatology: ClimatologyMonth[]
  currentMonths: (number | null)[]
  annual: AnnualPoint[]
  baselineAnnual: number
  peakMonthLabel: string
}

const BASELINE_FROM = 2003
const BASELINE_TO = 2025

export function dashboardForRegion(region: RegionSeries): Dashboard {
  const metrics = region.metrics
  const currentIndex = latestYearIndex(region.annual)
  const current = currentIndex >= 0 ? region.annual[currentIndex] : null
  return {
    name: region.name,
    biome: metrics.biome,
    insights: region.insights.slice(0, 3),
    confidence: metrics.confidence,
    factor: metrics.factor,
    uncertainty: metrics.uncertaintyPct,
    currentYear: current?.year ?? 2026,
    currentTotal: current?.total ?? metrics.currentYearTotal,
    currentAnomaly: current?.anomaly ?? metrics.currentYearAnomaly,
    peakYear: metrics.peakYear,
    peakTotal: metrics.peakYearTotal,
    trend: metrics.trendPctDecade,
    trendWindow: metrics.trendWindow,
    modisPct: metrics.modisPct,
    viirsPct: metrics.viirsPct,
    modisRaw: metrics.modisRaw,
    viirsRaw: metrics.viirsRaw,
    climatology: region.climatology,
    currentMonths: currentMonthsFromAnnual(region, currentIndex),
    annual: region.annual,
    baselineAnnual: metrics.baselineMeanAnnual,
    peakMonthLabel: region.peakMonthLabel,
  }
}

export function dashboardForPolygon(
  calendar: FilteredCalendar,
  years: number[],
  regions: RegionSeries[],
  hotspotInside: number,
): Dashboard {
  const annual = annualSeries(calendar.counts, years)
  const baselineYears = annual.filter((point) => point.year >= BASELINE_FROM && point.year <= BASELINE_TO && !point.partial)
  const baselineAnnual = mean(baselineYears.map((point) => point.total))
  const currentIndex = latestYearIndex(annual)
  const current = currentIndex >= 0 ? annual[currentIndex] : null
  const currentYear = current?.year ?? 2026
  const currentAnomaly = anomalyForYear(calendar.counts, years, currentYear)
  const peak = baselineYears.reduce<AnnualPoint | null>(
    (best, point) => (best === null || point.total > best.total ? point : best),
    null,
  )
  const climatology = climatologyOf(calendar.counts, years)
  const peakMonth = climatology.reduce((best, month, index) => (month.mean > climatology[best].mean ? index : best), 0)
  const sensor = sensorMix(calendar.rawModis, calendar.rawViirs)
  const active = calendar.weights.filter((weight) => weight.weight > 0)
  const weightSum = active.reduce((sum, weight) => sum + weight.weight, 0)
  const factor = weightSum === 0 ? 0 : active.reduce((sum, weight) => sum + weight.weight * factorOf(regions, weight.id), 0) / weightSum
  const uncertainty = weightSum === 0 ? 0 : active.reduce((sum, weight) => sum + weight.weight * uncertaintyOf(regions, weight.id), 0) / weightSum

  return {
    name: 'Recorte do mapa',
    biome: active.map((weight) => weight.name).join(' · '),
    insights: polygonInsights(active, currentAnomaly, hotspotInside, currentYear),
    confidence: 'estimada',
    factor,
    uncertainty,
    currentYear,
    currentTotal: current?.total ?? 0,
    currentAnomaly,
    peakYear: peak?.year ?? 0,
    peakTotal: peak?.total ?? 0,
    trend: trendPerDecade(baselineYears),
    trendWindow: '2003–2025',
    modisPct: sensor.modisPct,
    viirsPct: sensor.viirsPct,
    modisRaw: sensor.modisRaw,
    viirsRaw: sensor.viirsRaw,
    climatology,
    currentMonths: calendar.counts[years.indexOf(currentYear)] ?? Array.from({ length: 12 }, () => null),
    annual: annual.map((point) => ({
      ...point,
      anomaly: point.year === currentYear
        ? currentAnomaly
        : baselineAnnual === 0
          ? 0
          : ((point.total - baselineAnnual) / baselineAnnual) * 100,
    })),
    baselineAnnual,
    peakMonthLabel: climatology[peakMonth]?.label ?? '',
  }
}

function latestYearIndex(annual: AnnualPoint[]): number {
  for (let index = annual.length - 1; index >= 0; index -= 1) {
    if (annual[index].total > 0) return index
  }
  return annual.length - 1
}

function currentMonthsFromAnnual(region: RegionSeries, currentIndex: number): (number | null)[] {
  if (currentIndex < 0) return Array.from({ length: 12 }, () => null)
  const year = region.annual[currentIndex]?.year
  const yearIndex = year - 2000
  return region.counts[yearIndex] ?? Array.from({ length: 12 }, () => null)
}

function annualSeries(counts: (number | null)[][], years: number[]): AnnualPoint[] {
  return years.map((year, yearIndex) => {
    const row = counts[yearIndex] ?? []
    const known = row.filter((value): value is number => value !== null)
    return {
      year,
      total: known.reduce((sum, value) => sum + value, 0),
      partial: known.length < 12,
      anomaly: 0,
    }
  })
}

function anomalyForYear(counts: (number | null)[][], years: number[], year: number): number {
  const currentIndex = years.indexOf(year)
  if (currentIndex < 0) return 0
  const row = counts[currentIndex] ?? []
  let current = 0
  let baseline = 0
  let months = 0
  for (let month = 0; month < 12; month++) {
    if (row[month] === null || row[month] === undefined) continue
    const values: number[] = []
    for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
      const candidate = years[yearIndex]
      const value = counts[yearIndex]?.[month]
      if (candidate >= BASELINE_FROM && candidate <= BASELINE_TO && value !== null && value !== undefined) values.push(value)
    }
    if (values.length === 0) continue
    current += row[month] as number
    baseline += mean(values)
    months += 1
  }
  if (months === 0 || baseline === 0) return 0
  return ((current - baseline) / baseline) * 100
}

function climatologyOf(counts: (number | null)[][], years: number[]): ClimatologyMonth[] {
  const labels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  return labels.map((label, month) => {
    const values: number[] = []
    for (let yearIndex = 0; yearIndex < years.length; yearIndex++) {
      const year = years[yearIndex]
      const value = counts[yearIndex]?.[month]
      if (year >= BASELINE_FROM && year <= BASELINE_TO && value !== null && value !== undefined) values.push(value)
    }
    const sorted = values.slice().sort((a, b) => a - b)
    return { label, mean: mean(values), p05: percentile(sorted, 0.05), p95: percentile(sorted, 0.95) }
  })
}

function sensorMix(rawModis: (number | null)[][], rawViirs: (number | null)[][]) {
  const modisRaw = sumMatrix(rawModis)
  const viirsRaw = sumMatrix(rawViirs)
  const total = modisRaw + viirsRaw
  return {
    modisRaw,
    viirsRaw,
    modisPct: total === 0 ? 0 : (modisRaw / total) * 100,
    viirsPct: total === 0 ? 0 : (viirsRaw / total) * 100,
  }
}

function polygonInsights(active: RegionWeight[], anomaly: number, hotspotInside: number, year: number): string[] {
  const cover = active
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((weight) => `${weight.name} (${formatShare(weight.weight)})`)
    .join(', ')
  const direction = anomaly >= 0 ? 'acima' : 'abaixo'
  return [
    cover ? `O polígono cobre ${cover} de cada célula.` : 'O polígono não cruza as células da série.',
    `O acumulado de ${year} está ${formatSignedPercent(anomaly)} ${direction} da média do mesmo período nesse recorte.`,
    `${hotspotInside.toLocaleString('pt-BR')} focos da amostra 2024–2026 caem dentro do desenho.`,
  ]
}

function trendPerDecade(points: AnnualPoint[]): number {
  if (points.length < 2) return 0
  const xs = points.map((point) => point.year)
  const ys = points.map((point) => point.total)
  const meanX = mean(xs)
  const meanY = mean(ys)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index++) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  if (denominator === 0 || meanY === 0) return 0
  return ((numerator / denominator) * 10 / meanY) * 100
}

function factorOf(regions: RegionSeries[], id: string): number {
  return regions.find((region) => region.id === id)?.metrics.factor ?? 1
}

function uncertaintyOf(regions: RegionSeries[], id: string): number {
  return regions.find((region) => region.id === id)?.metrics.uncertaintyPct ?? 0
}

function sumMatrix(matrix: (number | null)[][]): number {
  return matrix.reduce((sum, row) => sum + row.reduce<number>((rowSum, value) => rowSum + (value ?? 0), 0), 0)
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * ratio
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] * (high - index) + sorted[high] * (index - low)
}
