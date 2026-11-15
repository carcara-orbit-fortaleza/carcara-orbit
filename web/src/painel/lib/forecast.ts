import type { LonLat, RegionSeries } from '../types'

// Calculadora de cenários. Tudo aqui é estatística simples sobre a série já carregada no painel:
// projeção por tendência linear, distribuição empírica dos anos de referência e uma aproximação
// geométrica para postos. Não é previsão operacional: o resultado é uma hipótese com probabilidade.

const BASELINE_FROM = 2003
const BASELINE_TO = 2025
const EARTH_RADIUS_KM = 6371
// Fator de rota: a distância em linha reta subestima o deslocamento por estradas.
const ROAD_FACTOR = 1.3
// Limiar de alerta: percentil da série anual de referência acima do qual o ano é "alto".
const ALERT_PERCENTILE = 0.75
// Limites para não extrapolar a tendência para valores absurdos em horizontes longos.
const MIN_FACTOR = 0.1
const MAX_FACTOR = 3

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

export type Forecast = {
  regionId: string
  regionName: string
  firstYear: number
  horizonYears: number
  alertThreshold: number
  baselineMean: number
  sampleYears: number
  trendPctDecade: number
  years: YearProjection[]
  months: MonthRisk[]
  peakMonths: string[]
  posts: PostPlan
  totals: { costBrl: number; avoidedFocuses: number; costPerAvoided: number | null }
  confidence: string
  uncertaintyPct: number
}

export type RegionOverview = {
  id: string
  name: string
  color: string
  expectedNext: number
  chanceAboveAlert: number
  areaKm2: number
}

export function forecastRegion(region: RegionSeries, years: number[], inputs: CalcInputs): Forecast {
  const firstYear = Math.max(...years, 2026) + 1
  const sample = baselineSample(region)
  const baselineMean = sample.length ? mean(sample) : region.metrics.baselineMeanAnnual
  const alertThreshold = percentile(sample, ALERT_PERCENTILE)
  const trend = region.metrics.trendPctDecade
  const horizon = clampInt(inputs.horizonYears, 1, 10)
  const areaKm2 = ringAreaKm2(region.ring)

  const monthly = region.climatology.map((month) => month.mean)
  const monthTotal = monthly.reduce((sum, value) => sum + value, 0)
  const maxMonth = Math.max(0, ...monthly)

  const projections: YearProjection[] = []
  let peakMonthlyExpected = 0
  for (let index = 0; index < horizon; index++) {
    const year = firstYear + index
    const factor = trendFactor(trend, year)
    const expected = baselineMean * factor
    const shifted = sample.map((value) => value * factor)
    const low = percentile(shifted, 0.05)
    const high = percentile(shifted, 0.95)
    const chance = sample.length
      ? sample.filter((value) => value * factor > alertThreshold).length / sample.length
      : 0
    const avoided = expected * (clampNumber(inputs.targetReductionPct, 0, 100) / 100)
    peakMonthlyExpected = Math.max(peakMonthlyExpected, maxMonth * factor)
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

  const posts = planPosts(areaKm2, peakMonthlyExpected, inputs)
  const annualCost = posts.recommendedPosts * Math.max(0, inputs.postCostPerYear)

  for (const projection of projections) {
    projection.costBrl = annualCost + projection.avoidedFocuses * Math.max(0, inputs.costPerAvoidedFocus)
    projection.costPerAvoided = projection.avoidedFocuses > 0 ? projection.costBrl / projection.avoidedFocuses : null
  }

  const totalCost = projections.reduce((sum, item) => sum + item.costBrl, 0)
  const totalAvoided = projections.reduce((sum, item) => sum + item.avoidedFocuses, 0)

  const months: MonthRisk[] = region.climatology.map((month) => {
    const share = monthTotal > 0 ? month.mean / monthTotal : 0
    return {
      label: month.label,
      expected: month.mean * (projections[0]?.factor ?? 1),
      share,
      peak: maxMonth > 0 && month.mean >= maxMonth * 0.5,
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

export function overviewRegions(regions: RegionSeries[], years: number[], inputs: CalcInputs): RegionOverview[] {
  return regions
    .map((region) => {
      const forecast = forecastRegion(region, years, { ...inputs, horizonYears: 1 })
      const next = forecast.years[0]
      return {
        id: region.id,
        name: region.name,
        color: region.color,
        expectedNext: next?.expected ?? 0,
        chanceAboveAlert: next?.chanceAboveAlert ?? 0,
        areaKm2: ringAreaKm2(region.ring),
      }
    })
    .sort((a, b) => b.chanceAboveAlert - a.chanceAboveAlert || b.expectedNext - a.expectedNext)
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

function trendFactor(trendPctDecade: number, year: number): number {
  const decadesAhead = (year - BASELINE_TO) / 10
  const factor = 1 + (trendPctDecade / 100) * decadesAhead
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor))
}

function baselineSample(region: RegionSeries): number[] {
  return region.annual
    .filter((point) => point.year >= BASELINE_FROM && point.year <= BASELINE_TO && !point.partial)
    .map((point) => point.total)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)))
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}
