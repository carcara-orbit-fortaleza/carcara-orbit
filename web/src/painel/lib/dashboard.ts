import type { PanelText } from './panelText'
import { formatCount, formatShare, formatSignedPercent } from './format'
import { anomalyPct, referenceValues } from './series'
import type { Baseline, FilteredCalendar, RegionWeight } from './series'
import { MIN_REFERENCE_YEARS } from './forecast'
import { mean, percentile } from './stats'
import type { AnnualPoint, ClimatologyMonth, RegionSeries } from '../types'

// Todo número que depende de dado ausente é null. A tela mostra "sem dado" em vez de um zero
// que pareceria medição.
export type Dashboard = {
  name: string
  biome: string
  insights: string[]
  confidence: string
  factor: number
  uncertainty: number | null
  currentYear: number
  /** Meses com dado no ano corrente, por exemplo "jan–nov". Vazio se o ano não tem dado. */
  currentMonthsLabel: string
  currentTotal: number | null
  currentAnomaly: number | null
  peakYear: number | null
  peakTotal: number | null
  trend: number | null
  trendWindow: string
  modisPct: number
  viirsPct: number
  modisRaw: number
  viirsRaw: number
  climatology: ClimatologyMonth[]
  currentMonths: (number | null)[]
  annual: AnnualPoint[]
  baselineAnnual: number | null
  peakMonthLabel: string
}

export type DashboardContext = {
  years: number[]
  currentYear: number
  baseline: Baseline
}

export function dashboardForRegion(region: RegionSeries, context: DashboardContext, text: PanelText): Dashboard {
  const metrics = region.metrics
  const currentMonths = rowOf(region.counts, context.years, context.currentYear)
  // Os rótulos de mês vêm da API em português; aqui trocamos pelo idioma atual.
  const climatology = region.climatology.map((month, index) => ({ ...month, label: text.monthShort[index] ?? month.label }))
  return {
    name: region.name,
    biome: metrics.biome,
    insights: region.insights.slice(0, 3),
    confidence: metrics.confidence,
    factor: metrics.factor,
    uncertainty: metrics.uncertaintyPct,
    currentYear: context.currentYear,
    currentMonthsLabel: monthsLabel(currentMonths, text.monthShort),
    currentTotal: metrics.currentYearTotal,
    currentAnomaly: metrics.currentYearAnomaly,
    peakYear: metrics.peakYear,
    peakTotal: metrics.peakYearTotal,
    trend: metrics.trendPctDecade,
    trendWindow: metrics.trendWindow || `${context.baseline.from}–${context.baseline.to}`,
    modisPct: metrics.modisPct,
    viirsPct: metrics.viirsPct,
    modisRaw: metrics.modisRaw,
    viirsRaw: metrics.viirsRaw,
    climatology,
    currentMonths,
    annual: region.annual,
    baselineAnnual: metrics.baselineMeanAnnual,
    peakMonthLabel: peakMonthOf(climatology),
  }
}

/** Anos completos e com dado dentro da janela de referência (a amostra do polígono). */
export function completeBaselineYears(annual: AnnualPoint[], baseline: Baseline): (AnnualPoint & { total: number })[] {
  return annual.filter(
    (point): point is AnnualPoint & { total: number } =>
      point.year >= baseline.from && point.year <= baseline.to && !point.partial && point.total !== null,
  )
}

export function dashboardForPolygon(
  calendar: FilteredCalendar,
  regions: RegionSeries[],
  hotspotInside: number,
  context: DashboardContext,
  hotspotWindowLabel: string,
  text: PanelText,
): Dashboard {
  const { years, currentYear, baseline } = context
  const annual = annualSeries(calendar.counts, years)
  const baselineYears = completeBaselineYears(annual, baseline)
  const baselineAnnual = baselineYears.length ? mean(baselineYears.map((point) => point.total)) : null
  const current = annual.find((point) => point.year === currentYear)
  const currentAnomaly = currentYearAnomaly(calendar.counts, years, currentYear, baseline)
  const peak = baselineYears.reduce<(AnnualPoint & { total: number }) | null>(
    (best, point) => (best === null || point.total > best.total ? point : best),
    null,
  )
  const climatology = climatologyOf(calendar.counts, years, baseline, text.monthShort)
  const peakMonth = climatology.reduce<number | null>(
    (best, month, index) =>
      month.mean !== null && (best === null || month.mean > (climatology[best].mean ?? -Infinity)) ? index : best,
    null,
  )
  const sensor = sensorMix(calendar.rawModis, calendar.rawViirs)
  const active = calendar.weights.filter((weight) => weight.weight > 0)
  const weightSum = active.reduce((sum, weight) => sum + weight.weight, 0)
  const named = active
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((weight) => weight.name)
  const biome = named.length === 0
    ? ''
    : active.length > named.length
      ? `${named.join(' · ')} +${active.length - named.length}`
      : named.join(' · ')
  const factor = weightSum === 0 ? 1 : active.reduce((sum, weight) => sum + weight.weight * factorOf(regions, weight.id), 0) / weightSum
  const uncertainties = active.map((weight) => ({ weight: weight.weight, value: uncertaintyOf(regions, weight.id) }))
  const uncertainty = weightSum === 0 || uncertainties.some((item) => item.value === null)
    ? null
    : uncertainties.reduce((sum, item) => sum + item.weight * (item.value as number), 0) / weightSum
  const currentMonths = rowOf(calendar.counts, years, currentYear)
  const currentMonthsLabel = monthsLabel(currentMonths, text.monthShort)

  return {
    name: text.t('panelPolygonName'),
    biome,
    insights: polygonInsights(active, currentAnomaly, hotspotInside, currentYear, currentMonthsLabel, hotspotWindowLabel, text),
    confidence: 'estimated',
    factor,
    uncertainty,
    currentYear,
    currentMonthsLabel,
    currentTotal: current?.total ?? null,
    currentAnomaly,
    peakYear: peak?.year ?? null,
    peakTotal: peak?.total ?? null,
    trend: trendPerDecade(baselineYears),
    trendWindow: `${baseline.from}–${baseline.to}`,
    modisPct: sensor.modisPct,
    viirsPct: sensor.viirsPct,
    modisRaw: sensor.modisRaw,
    viirsRaw: sensor.viirsRaw,
    climatology,
    currentMonths,
    annual: annual.map((point) => ({
      ...point,
      anomaly:
        point.year === currentYear
          ? currentAnomaly
          : point.total === null || point.partial || baselineAnnual === null || baselineAnnual === 0
            ? null
            : anomalyPct(point.total, baselineAnnual),
    })),
    baselineAnnual,
    peakMonthLabel: peakMonth === null || !((climatology[peakMonth].mean ?? 0) > 0) ? '—' : climatology[peakMonth].label,
  }
}

/** Mês de maior média histórica; "—" se nenhum mês tem média positiva. */
function peakMonthOf(climatology: ClimatologyMonth[]): string {
  let best: number | null = null
  climatology.forEach((month, index) => {
    if (month.mean !== null && month.mean > 0 && (best === null || month.mean > (climatology[best].mean ?? -Infinity))) best = index
  })
  return best === null ? '—' : climatology[best].label
}

function rowOf(counts: (number | null)[][], years: number[], year: number): (number | null)[] {
  const index = years.indexOf(year)
  return (index >= 0 ? counts[index] : undefined) ?? Array.from({ length: 12 }, () => null)
}

/** "jan–nov" para os meses com dado; "nov" se for um só; "" se nenhum. */
export function monthsLabel(row: (number | null)[], months: string[]): string {
  const known = row.map((value, month) => (value === null || value === undefined ? -1 : month)).filter((month) => month >= 0)
  if (known.length === 0) return ''
  const first = months[known[0]]
  const last = months[known[known.length - 1]]
  return first === last ? first : `${first}–${last}`
}

export function annualSeries(counts: (number | null)[][], years: number[]): AnnualPoint[] {
  return years.map((year, yearIndex) => {
    const row = counts[yearIndex] ?? []
    const known = row.filter((value): value is number => value !== null && value !== undefined)
    return {
      year,
      total: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
      partial: known.length < 12,
      anomaly: null,
    }
  })
}

export type CurrentAnomalyTrace = {
  value: number | null
  /** Meses (0..11) que entraram: têm dado no ano corrente E ao menos um ano de referência com dado. */
  monthsUsed: number[]
  /** Soma do ano corrente nesses meses. */
  current: number
  /** Soma das médias de referência desses meses. */
  reference: number
  /** Por mês usado: média de referência e quantos anos a compõem. */
  perMonth: { month: number; current: number; referenceMean: number; referenceYears: number[] }[]
}

/** Acumulado do ano corrente contra a média dos mesmos meses nos anos de referência. */
export function currentYearAnomalyTrace(
  counts: (number | null)[][],
  years: number[],
  currentYear: number,
  baseline: Baseline,
): CurrentAnomalyTrace {
  const empty: CurrentAnomalyTrace = { value: null, monthsUsed: [], current: 0, reference: 0, perMonth: [] }
  const currentIndex = years.indexOf(currentYear)
  if (currentIndex < 0) return empty
  const row = counts[currentIndex] ?? []
  let current = 0
  let reference = 0
  const perMonth: CurrentAnomalyTrace['perMonth'] = []
  for (let month = 0; month < 12; month++) {
    if (row[month] === null || row[month] === undefined) continue
    const ref = referenceValues(counts, years, baseline, month)
    if (ref.values.length === 0) continue
    const referenceMean = mean(ref.values)
    current += row[month] as number
    reference += referenceMean
    perMonth.push({ month, current: row[month] as number, referenceMean, referenceYears: ref.years })
  }
  const monthsUsed = perMonth.map((item) => item.month)
  if (monthsUsed.length === 0 || reference === 0) return { ...empty, monthsUsed, current, reference, perMonth }
  return { value: anomalyPct(current, reference), monthsUsed, current, reference, perMonth }
}

export function currentYearAnomaly(counts: (number | null)[][], years: number[], currentYear: number, baseline: Baseline): number | null {
  return currentYearAnomalyTrace(counts, years, currentYear, baseline).value
}

export type ClimatologyTrace = ClimatologyMonth & {
  /** Anos de referência com dado neste mês. */
  n: number
  years: number[]
}

/** Climatologia mensal com os anos usados (n pequeno => P05–P95 equivale a mínimo–máximo). */
export function climatologyTraceOf(
  counts: (number | null)[][],
  years: number[],
  baseline: Baseline,
  months: string[],
): ClimatologyTrace[] {
  return months.map((label, month) => {
    const ref = referenceValues(counts, years, baseline, month)
    if (ref.values.length === 0) return { label, mean: null, p05: null, p95: null, n: 0, years: [] }
    return {
      label,
      mean: mean(ref.values),
      p05: percentile(ref.values, 0.05),
      p95: percentile(ref.values, 0.95),
      n: ref.values.length,
      years: ref.years,
    }
  })
}

export function climatologyOf(counts: (number | null)[][], years: number[], baseline: Baseline, months: string[]): ClimatologyMonth[] {
  return climatologyTraceOf(counts, years, baseline, months).map(({ label, mean: m, p05, p95 }) => ({ label, mean: m, p05, p95 }))
}

export function sensorMix(rawModis: (number | null)[][], rawViirs: (number | null)[][]) {
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

function polygonInsights(
  active: RegionWeight[],
  anomaly: number | null,
  hotspotInside: number,
  currentYear: number,
  currentMonthsLabel: string,
  hotspotWindowLabel: string,
  text: PanelText,
): string[] {
  const { t, locale } = text
  const cover = active
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((weight) => `${weight.name} (${formatShare(weight.weight, locale)})`)
    .join(', ')
  const period = currentMonthsLabel ? `${currentYear} (${currentMonthsLabel})` : String(currentYear)
  const anomalyText = anomaly === null
    ? t('panelInsightNoReference', { period })
    : t('panelInsightAnomaly', {
        period,
        change: formatSignedPercent(Math.abs(anomaly), locale),
        direction: anomaly >= 0 ? t('panelAbove') : t('panelBelow'),
      })
  return [
    cover ? t('panelInsightCover', { cover }) : t('panelInsightNoBiomes'),
    anomalyText,
    t('panelInsightHotspots', { count: formatCount(hotspotInside, locale), window: hotspotWindowLabel }),
  ]
}

export type TrendTrace = {
  value: number | null
  /** Anos completos usados. */
  n: number
  meanX: number
  meanY: number
  /** Inclinação em focos/ano (mínimos quadrados). null quando não calculada. */
  slopePerYear: number | null
  /** Por que não há valor: poucos anos ou série degenerada (média zero / anos iguais). */
  reason: 'insufficient-reference' | 'degenerate' | null
}

/** Tendência linear em % da média por década, com os intermediários. */
export function trendTrace(points: { year: number; total: number }[]): TrendTrace {
  if (points.length < MIN_REFERENCE_YEARS) {
    return { value: null, n: points.length, meanX: 0, meanY: 0, slopePerYear: null, reason: 'insufficient-reference' }
  }
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
  if (denominator === 0 || meanY === 0) return { value: null, n: points.length, meanX, meanY, slopePerYear: null, reason: 'degenerate' }
  const slope = numerator / denominator
  return { value: ((slope * 10) / meanY) * 100, n: points.length, meanX, meanY, slopePerYear: slope, reason: null }
}

/** Tendência linear em % da média por década. null com menos de MIN_REFERENCE_YEARS anos completos. */
export function trendPerDecade(points: { year: number; total: number }[]): number | null {
  return trendTrace(points).value
}

function factorOf(regions: RegionSeries[], id: string): number {
  return regions.find((region) => region.id === id)?.metrics.factor ?? 1
}

function uncertaintyOf(regions: RegionSeries[], id: string): number | null {
  return regions.find((region) => region.id === id)?.metrics.uncertaintyPct ?? null
}

function sumMatrix(matrix: (number | null)[][]): number {
  return matrix.reduce((sum, row) => sum + row.reduce<number>((rowSum, value) => rowSum + (value ?? 0), 0), 0)
}
