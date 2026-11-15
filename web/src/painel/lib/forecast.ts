import type { LonLat, RegionSeries } from '../types'
import type { Baseline } from './series'
import { mean, percentile } from './stats'

// Calculadora de cenários. Tudo aqui é estatística simples sobre a série já carregada no painel:
// projeção por tendência linear, distribuição empírica dos anos de referência e uma aproximação
// geométrica para postos. Não é previsão operacional: o resultado é uma hipótese com probabilidade.

// Mínimo de anos completos de referência para a calculadora projetar alguma coisa.
// Abaixo disso, percentis e chance de "ano alto" seriam ruído e a tela mostra um estado vazio.
export const MIN_REFERENCE_YEARS = 5
const EARTH_RADIUS_KM = 6371
// Fator de rota: a distância em linha reta subestima o deslocamento por estradas.
export const ROAD_FACTOR = 1.3
// Limiar de alerta padrão: percentil da série anual de referência acima do qual o ano é "alto".
// Pode ser sobrescrito por ForecastOptions.alertPercentile (camada "E se?").
export const DEFAULT_ALERT_PERCENTILE = 0.75
// Limites para não extrapolar a tendência para valores absurdos em horizontes longos.
export const MIN_FACTOR = 0.1
export const MAX_FACTOR = 3
// Faixa de incerteza exibida por ano: P05–P95 da amostra deslocada pelo fator.
export const RANGE_LOW_P = 0.05
export const RANGE_HIGH_P = 0.95
// Razão do pico mensal a partir da qual um mês é considerado "de pico".
export const PEAK_MONTH_RATIO = 0.5
// Janelas pequenas: P05–P95 equivale a mínimo–máximo (ver caveat range-is-minmax).
export const SMALL_SAMPLE_N = 20

export type ForecastOptions = {
  /** Percentil (0..1) do limiar de alerta. Padrão DEFAULT_ALERT_PERCENTILE. */
  alertPercentile?: number
}

export type CalcInputs = {
  horizonYears: number
  existingPosts: number
  coverageRadiusKm: number
  travelSpeedKmh: number
  postCostPerYear: number
  costPerAvoidedFocus: number
  targetReductionPct: number
  focusesPerPostMonth: number
}

// Premissas de exemplo. Não são dados oficiais: o usuário deve trocá-las pelos custos reais.
export const DEFAULT_INPUTS: CalcInputs = {
  horizonYears: 5,
  existingPosts: 0,
  coverageRadiusKm: 50,
  travelSpeedKmh: 40,
  postCostPerYear: 1_200_000,
  costPerAvoidedFocus: 2_000,
  targetReductionPct: 30,
  focusesPerPostMonth: 40,
}

export type YearProjection = {
  year: number
  factor: number
  expected: number
  low: number
  high: number
  chanceAboveAlert: number
  avoidedFocuses: number
  costBrl: number
  costPerAvoided: number | null
}

export type MonthRisk = {
  label: string
  expected: number
  share: number
  peak: boolean
}

export type PostPlan = {
  areaKm2: number
  coverageMinPosts: number
  workloadPosts: number
  recommendedPosts: number
  currentMinutes: number | null
  recommendedMinutes: number
  missingPosts: number
}

export type ForecastContext = {
  currentYear: number
  baseline: Baseline
}

export type Forecast = {
  regionId: string
  regionName: string
  firstYear: number
  horizonYears: number
  alertThreshold: number
  baselineMean: number
  sampleYears: number
  trendPctDecade: number | null
  /** false quando há menos de MIN_REFERENCE_YEARS anos completos: nada aqui deve ser exibido como projeção. */
  sufficient: boolean
  years: YearProjection[]
  months: MonthRisk[]
  peakMonths: string[]
  posts: PostPlan
  totals: { costBrl: number; avoidedFocuses: number; costPerAvoided: number | null }
  confidence: string
  uncertaintyPct: number | null
}

export type RegionOverview = {
  id: string
  name: string
  color: string
  expectedNext: number
  chanceAboveAlert: number
  areaKm2: number
  sufficient: boolean
}

export function forecastRegion(
  region: RegionSeries,
  inputs: CalcInputs,
  context: ForecastContext,
  options: ForecastOptions = {},
): Forecast {
  const firstYear = context.currentYear + 1
  const sample = baselineSample(region, context.baseline)
  const sufficient = sample.length >= MIN_REFERENCE_YEARS
  const baselineMean = sample.length ? mean(sample) : region.metrics.baselineMeanAnnual ?? 0
  const alertThreshold = percentile(sample, options.alertPercentile ?? DEFAULT_ALERT_PERCENTILE)
  const trend = region.metrics.trendPctDecade
  const trendFrom = context.baseline.to
  const horizon = clampInt(inputs.horizonYears, 1, 10)
  const areaKm2 = ringAreaKm2(region.ring)

  const monthly = monthlyMeans(region)
  const monthTotal = monthly.reduce((sum, value) => sum + value, 0)
  const maxMonth = Math.max(0, ...monthly)

  const projections: YearProjection[] = []
  for (let index = 0; index < horizon; index++) {
    const year = firstYear + index
    const factor = trendFactor(trend ?? 0, year, trendFrom)
    const expected = baselineMean * factor
    const shifted = sample.map((value) => value * factor)
    const low = percentile(shifted, RANGE_LOW_P)
    const high = percentile(shifted, RANGE_HIGH_P)
    const chance = exceedance(sample, factor, alertThreshold).chance
    const avoided = expected * (clampNumber(inputs.targetReductionPct, 0, 100) / 100)
    projections.push({
      year,
      factor,
      expected,
      low,
      high,
      chanceAboveAlert: chance,
      avoidedFocuses: avoided,
      costBrl: 0,
      costPerAvoided: null,
    })
  }

  const posts = planPosts(areaKm2, peakMonthlyExpectedOf(region, projections.map((item) => item.factor)), inputs)
  const annualCost = posts.recommendedPosts * Math.max(0, inputs.postCostPerYear)

  for (const projection of projections) {
    projection.costBrl = annualCost + projection.avoidedFocuses * Math.max(0, inputs.costPerAvoidedFocus)
    projection.costPerAvoided = projection.avoidedFocuses > 0 ? projection.costBrl / projection.avoidedFocuses : null
  }

  const totalCost = projections.reduce((sum, item) => sum + item.costBrl, 0)
  const totalAvoided = projections.reduce((sum, item) => sum + item.avoidedFocuses, 0)

  const months: MonthRisk[] = region.climatology.map((month) => {
    const value = month.mean ?? 0
    const share = monthTotal > 0 ? value / monthTotal : 0
    return {
      label: month.label,
      expected: value * (projections[0]?.factor ?? 1),
      share,
      peak: maxMonth > 0 && value >= maxMonth * PEAK_MONTH_RATIO,
    }
  })

  return {
    regionId: region.id,
    regionName: region.name,
    firstYear,
    horizonYears: horizon,
    alertThreshold,
    baselineMean,
    sampleYears: sample.length,
    trendPctDecade: trend,
    sufficient,
    years: projections,
    months,
    peakMonths: months.filter((month) => month.peak).map((month) => month.label),
    posts,
    totals: {
      costBrl: totalCost,
      avoidedFocuses: totalAvoided,
      costPerAvoided: totalAvoided > 0 ? totalCost / totalAvoided : null,
    },
    confidence: region.metrics.confidence,
    uncertaintyPct: region.metrics.uncertaintyPct,
  }
}

export function overviewRegions(
  regions: RegionSeries[],
  inputs: CalcInputs,
  context: ForecastContext,
  options: ForecastOptions = {},
): RegionOverview[] {
  return regions
    .map((region) => {
      const forecast = forecastRegion(region, { ...inputs, horizonYears: 1 }, context, options)
      const next = forecast.years[0]
      return {
        id: region.id,
        name: region.name,
        color: region.color,
        expectedNext: next?.expected ?? 0,
        chanceAboveAlert: next?.chanceAboveAlert ?? 0,
        areaKm2: ringAreaKm2(region.ring),
        sufficient: forecast.sufficient,
      }
    })
    .sort((a, b) => Number(b.sufficient) - Number(a.sufficient) || b.chanceAboveAlert - a.chanceAboveAlert || b.expectedNext - a.expectedNext)
}

/**
 * Postos necessários por dois critérios e o maior vence:
 * cobertura (círculos de raio fixo cobrindo a área) e carga (focos no mês de pico por posto).
 * O tempo de resposta usa a distância média até o posto mais próximo, aproximada para postos
 * distribuídos uniformemente: d ≈ 0,5 · √(A / N), com fator de rota.
 */
export function planPosts(areaKm2: number, peakMonthlyExpected: number, inputs: CalcInputs): PostPlan {
  const radius = Math.max(1, inputs.coverageRadiusKm)
  const coverageMinPosts = areaKm2 > 0 ? Math.ceil(areaKm2 / (Math.PI * radius * radius)) : 0
  const perPost = Math.max(1, inputs.focusesPerPostMonth)
  const workloadPosts = Math.ceil(peakMonthlyExpected / perPost)
  const recommendedPosts = Math.max(1, coverageMinPosts, workloadPosts)
  const existing = Math.max(0, Math.round(inputs.existingPosts))
  return {
    areaKm2,
    coverageMinPosts,
    workloadPosts,
    recommendedPosts,
    currentMinutes: existing > 0 ? responseMinutes(areaKm2, existing, inputs.travelSpeedKmh) : null,
    recommendedMinutes: responseMinutes(areaKm2, recommendedPosts, inputs.travelSpeedKmh),
    missingPosts: Math.max(0, recommendedPosts - existing),
  }
}

export function responseMinutes(areaKm2: number, posts: number, speedKmh: number): number {
  if (posts <= 0 || areaKm2 <= 0 || speedKmh <= 0) return 0
  const distanceKm = 0.5 * Math.sqrt(areaKm2 / posts) * ROAD_FACTOR
  return (distanceKm / speedKmh) * 60
}

/** Área aproximada (km²) de um anel lon/lat em esfera. */
export function ringAreaKm2(ring: LonLat[]): number {
  if (ring.length < 3) return 0
  let sum = 0
  for (let index = 0; index < ring.length; index++) {
    const [lon1, lat1] = ring[index]
    const [lon2, lat2] = ring[(index + 1) % ring.length]
    const dLon = ((lon2 - lon1) * Math.PI) / 180
    sum += dLon * (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180))
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2)
}

/** Média histórica por mês (null vira 0 SÓ aqui, para somar e achar o pico; a UI de clima continua mostrando null). */
export function monthlyMeans(region: RegionSeries): number[] {
  return region.climatology.map((month) => month.mean ?? 0)
}

/** Maior média mensal histórica × maior fator projetado: o pico mensal esperado que dimensiona a carga dos postos. */
export function peakMonthlyExpectedOf(region: RegionSeries, factors: number[]): number {
  const maxMonth = Math.max(0, ...monthlyMeans(region))
  return factors.reduce((best, factor) => Math.max(best, maxMonth * factor), 0)
}

export type TrendFactorTrace = {
  /** Fator aplicado (já limitado). */
  factor: number
  /** Fator linear antes do limite: 1 + tendência × décadas à frente. */
  raw: number
  decadesAhead: number
  /** 'min' | 'max' quando o limite atuou; null caso contrário. */
  clamped: 'min' | 'max' | null
}

/** Fator de tendência com o intermediário e a indicação de limite atingido. */
export function trendFactorTrace(trendPctDecade: number, year: number, fromYear: number): TrendFactorTrace {
  const decadesAhead = (year - fromYear) / 10
  const raw = 1 + (trendPctDecade / 100) * decadesAhead
  const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, raw))
  return { factor, raw, decadesAhead, clamped: raw > MAX_FACTOR ? 'max' : raw < MIN_FACTOR ? 'min' : null }
}

export function trendFactor(trendPctDecade: number, year: number, fromYear: number): number {
  return trendFactorTrace(trendPctDecade, year, fromYear).factor
}

export type BaselineSampleTrace = {
  /** Anos completos e com dado dentro da janela, em ordem de aparição. */
  years: number[]
  values: number[]
  /** Anos da janela fora da amostra, com o motivo. */
  excluded: { year: number; reason: 'partial' | 'no-data' }[]
}

/** Amostra de referência (totais anuais) com os anos de origem. */
export function baselineSampleTrace(region: RegionSeries, baseline: Baseline): BaselineSampleTrace {
  const years: number[] = []
  const values: number[] = []
  const excluded: BaselineSampleTrace['excluded'] = []
  for (const point of region.annual) {
    if (point.year < baseline.from || point.year > baseline.to) continue
    if (point.partial) excluded.push({ year: point.year, reason: 'partial' })
    else if (point.total === null) excluded.push({ year: point.year, reason: 'no-data' })
    else {
      years.push(point.year)
      values.push(point.total)
    }
  }
  return { years, values, excluded }
}

export function baselineSample(region: RegionSeries, baseline: Baseline): number[] {
  return baselineSampleTrace(region, baseline).values
}

/** Quantos anos da amostra, deslocados pelo fator, passam do limiar. Taxa empírica, não probabilidade calibrada. */
export function exceedance(sample: number[], factor: number, threshold: number): { count: number; n: number; chance: number } {
  const count = sample.filter((value) => value * factor > threshold).length
  return { count, n: sample.length, chance: sample.length ? count / sample.length : 0 }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)))
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}
