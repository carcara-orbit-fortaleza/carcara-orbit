import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUTS, forecastRegion } from '../lib/forecast'
import { dashboardForPolygon, dashboardForRegion } from '../lib/dashboard'
import { filterCalendar } from '../lib/series'
import type { DatasetMeta } from '../types'
import {
  explainAnnual,
  explainAnomaly,
  explainCalendarCell,
  explainClimatology,
  explainConfidence,
  explainCount,
  explainForecastYear,
  explainMethodFactor,
  explainPeak,
  explainPostPlan,
  explainSensorMix,
  explainTrend,
  isNotOperational,
  isPolygonWithoutOverlap,
} from './builders'
import type { ExplainData } from './builders'
import type { ExplainContext } from './types'
import { CURRENT_YEAR, MONTHS, POLYGON_AB, YEARS, regionA, regionB, text } from './fixtures'

const baseline = { from: 2018, to: 2024 }
const context = { currentYear: CURRENT_YEAR, baseline }
const dashContext = { years: YEARS, currentYear: CURRENT_YEAR, baseline }
const meta = (mode: DatasetMeta['mode'] = 'real'): DatasetMeta => ({
  mode, methodVersion: 'm-test', datasetVersion: 'd-test', currentYear: CURRENT_YEAR, baselineFrom: 2018, baselineTo: 2024,
  calibrationWindow: '2018–2019', periodStart: '2018-01-01', periodEnd: '2026-10-31', lastCompleteYear: 2025, warnings: [],
})
const ids = (c: ExplainContext) => c.caveats.map((x) => x.id)
const step = (c: ExplainContext, id: string) => c.formula.steps.find((s) => s.id === id)!

function regionData(overrides = {}, mode: DatasetMeta['mode'] = 'real'): ExplainData {
  const region = regionA({ currentYearTotal: 3000, currentYearAnomaly: 12, peakYear: 2024, peakYearTotal: 1855, ...overrides })
  return { meta: meta(mode), years: YEARS, months: MONTHS, currentYear: CURRENT_YEAR, baseline, region, regions: [region],
    dashboard: dashboardForRegion(region, dashContext, text) }
}

function polygonData(): ExplainData {
  const regions = [regionA({ factor: 1.2, uncertaintyPct: 40, confidence: 'medium' }), regionB({ factor: 1.4, uncertaintyPct: 60, confidence: 'medium' })]
  const calendar = filterCalendar(regions, YEARS, POLYGON_AB, 'a', baseline)
  return { meta: meta(), years: YEARS, months: MONTHS, currentYear: CURRENT_YEAR, baseline, regions, calendar, region: null,
    dashboard: dashboardForPolygon(calendar, regions, 5, dashContext, '7d', text) }
}

describe('isNotOperational', () => {
  it('estado raso (fator 1 e incerteza 100) e confiança baixa são não operacionais', () => {
    expect(isNotOperational({ factor: 1, uncertaintyPct: 100, confidence: 'medium' })).toBe(true)
    expect(isNotOperational({ factor: 1, uncertaintyPct: null, confidence: 'high' })).toBe(true)
    expect(isNotOperational({ factor: 1.3, uncertaintyPct: 30, confidence: 'low' })).toBe(true)
    expect(isNotOperational({ factor: 1.3, uncertaintyPct: 30, confidence: 'medium' })).toBe(false)
    expect(isNotOperational({ factor: 1, uncertaintyPct: 20, confidence: 'estimated' })).toBe(false)
  })
})

describe('modo região (valores da API)', () => {
  const data = regionData()

  it('count/anomaly/peak/trend/confidence/method usam derivedBy api com um passo citando a methodVersion', () => {
    for (const build of [explainCount, explainAnomaly, explainPeak, explainTrend]) {
      const c = build(data)
      expect(c.formula.derivedBy).toBe('api')
      expect(c.formula.steps[0].values.methodVersion).toBe('m-test')
      expect(c.source.datasetMode).toBe('real')
      expect(c.scope).toEqual({ mode: 'region', regionId: 'a', regionName: 'Região a' })
    }
    expect(explainCount(data).value.raw).toBe(3000)
    expect(explainAnomaly(data).value.raw).toBe(12)
    expect(explainPeak(data).value.raw).toBe(1855)
    expect(explainPeak(data).formula.steps[0].values.peakYear).toBe(2024)
    expect(explainTrend(data).value.raw).toBe(10)
  })

  it('estado raso real: not-operational presente, nunca erro; confiança/fator expõem o predicado', () => {
    const c = explainConfidence(data) // fixture: fator 1, incerteza 100, confiança low
    expect(ids(c)).toContain('not-operational')
    expect(step(c, 'operational-check').result).toBe(true)
    expect(explainMethodFactor(data).value.raw).toBe(1)
    expect(ids(explainMethodFactor(data))).toEqual(expect.arrayContaining(['not-operational', 'sensor-mix']))
  })

  it('calibrado: sem not-operational', () => {
    const calibrated = regionData({ factor: 1.3, uncertaintyPct: 25, confidence: 'medium' })
    expect(ids(explainCount(calibrated))).not.toContain('not-operational')
    expect(step(explainConfidence(calibrated), 'operational-check').result).toBe(false)
  })

  it('mock-data só em modo mock', () => {
    expect(ids(explainCount(data))).not.toContain('mock-data')
    const mock = regionData({}, 'mock')
    expect(ids(explainCount(mock))).toContain('mock-data')
    expect(explainCount(mock).source.datasetMode).toBe('mock')
    expect(explainCount({ ...data, meta: null }).source.datasetMode).toBe('unknown')
  })

  it('null nunca vira 0: tendência/anomalia/pico/total null ficam null', () => {
    const empty = regionData({ trendPctDecade: null, currentYearAnomaly: null, peakYear: null, peakYearTotal: null, currentYearTotal: null, uncertaintyPct: null })
    for (const build of [explainCount, explainAnomaly, explainPeak, explainTrend]) {
      const c = build(empty)
      expect(c.value.raw).toBeNull()
      expect(c.formula.steps[0].result).toBeNull()
    }
    expect(explainConfidence(empty).value.raw).toBeNull()
    expect(explainConfidence(empty).uncertainty.pct).toBeNull()
  })

  it('trend-anchor só quando a janela da API difere da do cenário; sempre hotspot-proxy', () => {
    expect(ids(explainTrend(data))).not.toContain('trend-anchor') // trendWindow '' -> cai para baseline
    const other = regionData({ trendWindow: '2010–2020' })
    expect(ids(explainTrend(other))).toContain('trend-anchor')
    expect(ids(explainTrend(other))).toContain('hotspot-proxy')
    expect(ids(explainTrend(other))).toContain('sensor-mix')
  })

  it('amostra de referência: peak/trend com n=6 e insufficient-reference com n<5', () => {
    expect(explainPeak(data).uncertainty.sampleSize).toBe(6)
    expect(ids(explainPeak(data))).not.toContain('insufficient-reference')
    const short = { ...data, baseline: { from: 2022, to: 2024 } }
    expect(explainPeak(short).uncertainty.sampleSize).toBe(3)
    expect(ids(explainPeak(short))).toContain('insufficient-reference')
  })

  it('sensor mix: valores crus, participação calculada e null sem detecção', () => {
    const withRaw = regionData({ modisRaw: 30, viirsRaw: 70 })
    const c = explainSensorMix(withRaw)
    expect(c.value.raw).toBeCloseTo(30, 9)
    expect(step(c, 'share').values).toMatchObject({ modisRaw: 30, viirsRaw: 70 })
    expect(c.source.sensors).toEqual(['MODIS', 'VIIRS'])
    expect(ids(c)).toContain('sensor-mix')
    const none = explainSensorMix(regionData({ modisRaw: 0, viirsRaw: 0 }))
    expect(none.value.raw).toBeNull()
    expect(step(none, 'share').result).toBeNull()
    expect(none.source.sensors).toEqual([])
  })

  it('climatologia por mês: api, n, intervalo min-max com n pequeno', () => {
    const c = explainClimatology(data, 7) // ago
    expect(c.formula.derivedBy).toBe('api')
    expect(c.value.raw).toBeCloseTo(400, 9) // 100 * média(1..7); ago/2018 tem dado
    expect(c.uncertainty.sampleSize).toBe(7)
    expect(c.uncertainty.interval.label).toBe('min-max')
    expect(ids(c)).toContain('range-is-minmax')
    expect(c.history.highlightX).toBe('ago')
    expect(c.history.points).toHaveLength(12)
  })

  it('climatologia sem mês: mês de pico; mês sem dado vira null/none', () => {
    const peak = explainClimatology(data)
    expect(peak.history.highlightX).toBe('ago')
    const jan = explainClimatology(data, 0)
    expect(jan.value.raw).toBe(0) // média real de jan é 0 (contagem 0), não ausência
    const noData = regionData()
    noData.dashboard = { ...noData.dashboard, climatology: noData.dashboard.climatology.map((m) => ({ ...m, mean: null, p05: null, p95: null })) }
    const c = explainClimatology(noData, 7)
    expect(c.value.raw).toBeNull()
    expect(c.uncertainty.interval).toEqual({ low: null, high: null, label: 'none' })
  })

  it('anual: soma dos meses, ano parcial não vira desvio', () => {
    const full = explainAnnual(data, 2023)
    expect(full.value.raw).toBe(265 * 6)
    expect(step(full, 'deviation').result).toBeCloseTo(((265 * 6 - 1192.5) / 1192.5) * 100, 9)
    const partial = explainAnnual(data) // 2026: jan–out
    expect(step(partial, 'sum').values.partial).toBe(true)
    expect(step(partial, 'deviation').result).toBeNull()
    expect(partial.history.points.find((p) => p.x === 2026)?.partial).toBe(true)
    const missing = explainAnnual(data, 1999)
    expect(missing.value.raw).toBeNull()
  })

  it('célula do calendário: valor, referência e anomalia iguais ao filterCalendar', () => {
    const c = explainCalendarCell(data, 2023, 7)
    const calendar = filterCalendar([data.region!], YEARS, null, 'a', baseline)
    expect(c.value.raw).toBe(calendar.counts[5][7])
    expect(step(c, 'anomaly').result).toBeCloseTo(calendar.anomaly[5][7] as number, 9)
    expect(step(c, 'reference').values.n).toBe(7)
    expect(c.history.highlightX).toBe(2023)
    // célula sem dado: null, anomalia null
    const empty = explainCalendarCell(data, 2018, 0)
    expect(empty.value.raw).toBeNull()
    expect(step(empty, 'anomaly').result).toBeNull()
    expect(step(explainCalendarCell(data, 2026, 10), 'anomaly').result).toBeNull()
    // mês sem régua (média 0): anomalia null
    expect(step(explainCalendarCell(data, 2023, 0), 'anomaly').result).toBeNull()
    // fora do intervalo: sem throw
    expect(explainCalendarCell(data, 1900, 99).value.raw).toBeNull()
  })
})

describe('modo polígono (client)', () => {
  const data = polygonData()

  it('contagem: soma ponderada e pesos no escopo; polygon-approximation', () => {
    const c = explainCount(data)
    expect(c.formula.derivedBy).toBe('client')
    expect(c.value.raw).toBe(data.dashboard.currentTotal)
    expect(c.scope.mode).toBe('polygon')
    expect(c.scope.regionId).toBeNull()
    expect(c.scope.weights?.map((w) => w.regionId)).toEqual(['a', 'b'])
    expect(ids(c)).toContain('polygon-approximation')
    const w = step(c, 'weights').values
    expect(w.w_a).toBeCloseTo(0.3, 6)
  })

  it('anomalia: passos substituídos reproduzem o valor do dashboard', () => {
    const c = explainAnomaly(data)
    const reference = step(c, 'reference').result as number
    const current = step(c, 'current').result as number
    expect(((current - reference) / reference) * 100).toBeCloseTo(data.dashboard.currentAnomaly as number, 9)
    expect(c.value.raw).toBe(data.dashboard.currentAnomaly)
    expect(c.whatIf?.controls).toEqual(['baseline'])
  })

  it('pico e tendência: reproduzem o dashboard (n=7: no polígono jan/2018 de B tem dado, a célula não é null)', () => {
    const peak = explainPeak(data)
    expect(peak.value.raw).toBe(data.dashboard.peakTotal)
    expect(peak.uncertainty.sampleSize).toBe(7)
    const trend = explainTrend(data)
    expect(trend.value.raw).toBe(data.dashboard.trend)
    const slope = step(trend, 'slope').result as number
    const mean = step(trend, 'mean').result as number
    expect((slope * 10) / mean * 100).toBeCloseTo(data.dashboard.trend as number, 9)
  })

  it('confiança/fator: média ponderada e confiança estimated; incerteza null se uma região não tem', () => {
    const c = explainMethodFactor(data)
    const v = step(c, 'factor').values
    const sw = (v.w_a as number) + (v.w_b as number)
    expect(((v.w_a as number) * (v.factor_a as number) + (v.w_b as number) * (v.factor_b as number)) / sw).toBeCloseTo(c.value.raw as number, 9)
    expect(explainConfidence(data).uncertainty.confidence).toBe('estimated')
    expect(ids(explainConfidence(data))).not.toContain('not-operational') // calibrado nas fixtures
    const regions = [regionA({ uncertaintyPct: null }), regionB()]
    const calendar = filterCalendar(regions, YEARS, POLYGON_AB, 'a', baseline)
    const nullData = { ...data, regions, calendar, dashboard: dashboardForPolygon(calendar, regions, 0, dashContext, '', text) }
    expect(explainConfidence(nullData).value.raw).toBeNull()
  })

  it('célula do calendário em polígono: blend ponderado e valores por região (null preservado)', () => {
    const c = explainCalendarCell(data, 2026, 10) // nov/2026: a null, b com dado? b tem [8][11] null, [8][10] dado
    const calendar = data.calendar!
    expect(c.value.raw).toBe(calendar.counts[8][10])
    expect(step(c, 'blend').values.v_a).toBeNull()
    expect(step(c, 'blend').values.v_b).not.toBeNull()
    const both = explainCalendarCell(data, 2026, 11) // dez/2026: ambas null
    expect(both.value.raw).toBeNull()
    expect(calendar.counts[8][11]).toBeNull()
  })

  it('climatologia em polígono: client, mesma média do dashboard', () => {
    const c = explainClimatology(data, 7)
    expect(c.formula.derivedBy).toBe('client')
    expect(c.value.raw).toBe(data.dashboard.climatology[7].mean)
    expect(step(c, 'sample').result).toBe(c.uncertainty.sampleSize)
  })

  it('sensor mix no polígono usa os brutos do calendário', () => {
    const c = explainSensorMix(data)
    expect(step(c, 'sum-raw').values.modisRaw).toBe(data.dashboard.modisRaw)
  })
})

describe('calculadora: forecast-year e post-plan', () => {
  const region = regionA({ trendPctDecade: 10 })
  const inputs = { ...DEFAULT_INPUTS, horizonYears: 3, existingPosts: 0 }

  it('valores substituídos são iguais ao forecastRegion', () => {
    const forecast = forecastRegion(region, inputs, context)
    for (let i = 0; i < 3; i++) {
      const c = explainForecastYear(region, inputs, context, i, { meta: meta() })
      const y = forecast.years[i]
      expect(c.value.raw).toBe(y.expected)
      expect(step(c, 'expected').result).toBe(y.expected)
      expect(step(c, 'factor').result).toBe(y.factor)
      expect(step(c, 'threshold').result).toBe(forecast.alertThreshold)
      expect(step(c, 'range').values).toMatchObject({ p05: y.low, p95: y.high })
      expect(step(c, 'exceedance').result).toBe(y.chanceAboveAlert)
      expect(c.uncertainty.interval).toEqual({ low: y.low, high: y.high, label: 'min-max' })
      expect(c.uncertainty.sampleSize).toBe(6)
      expect(c.history.highlightX).toBe(y.year)
      expect(c.whatIf?.controls).toEqual(['baseline', 'trend', 'alertPercentile', 'horizonYear'])
      expect(c.whatIf?.current).toMatchObject({ baselineFrom: 2018, baselineTo: 2024, alertPercentile: 0.75, trendPctDecade: 10, horizonYear: y.year })
    }
  })

  it('caveats esperados e ausência de insufficient-reference com n=6', () => {
    const c = explainForecastYear(region, inputs, context, 0)
    expect(ids(c)).toEqual(expect.arrayContaining(['not-operational', 'range-is-minmax', 'exceedance-not-calibrated', 'trend-anchor', 'hotspot-proxy', 'placeholder-costs']))
    expect(ids(c)).not.toContain('insufficient-reference')
    expect(ids(c)).not.toContain('polygon-approximation')
    expect(c.source.datasetMode).toBe('unknown')
  })

  it('fator limitado aparece no passo; tendência null mostra trendIsNull, não 0 escondido', () => {
    const steep = explainForecastYear(regionA({ trendPctDecade: 500 }), { ...inputs, horizonYears: 10 }, context, 3)
    expect(step(steep, 'factor').values.clamped).toBe('max')
    expect(step(steep, 'factor').result).toBe(3)
    const noTrend = explainForecastYear(regionA({ trendPctDecade: null }), inputs, context, 0)
    expect(step(noTrend, 'factor').values).toMatchObject({ trendPctDecade: null, trendIsNull: true, trendUsed: 0 })
    expect(noTrend.whatIf?.current.trendPctDecade).toBeNull()
  })

  it('amostra insuficiente: valor null, intervalo none, insufficient-reference', () => {
    const c = explainForecastYear(region, inputs, { currentYear: CURRENT_YEAR, baseline: { from: 2022, to: 2024 } }, 0)
    expect(c.value.raw).toBeNull()
    expect(c.uncertainty.interval).toEqual({ low: null, high: null, label: 'none' })
    expect(ids(c)).toContain('insufficient-reference')
    expect(c.uncertainty.sampleSize).toBe(3)
    expect(ids(explainPostPlan(region, inputs, { currentYear: CURRENT_YEAR, baseline: { from: 2022, to: 2024 } }))).toContain('insufficient-reference')
    expect(explainPostPlan(region, inputs, { currentYear: CURRENT_YEAR, baseline: { from: 2022, to: 2024 } }).value.raw).toBeNull()
  })

  it('percentil de alerta e polígono sintético entram no contexto', () => {
    const c = explainForecastYear(region, inputs, context, 0, { alertPercentile: 0.9, polygon: { name: 'P', weights: [{ regionId: 'a', weight: 1 }] } })
    expect(step(c, 'threshold').values.alertPercentile).toBe(0.9)
    expect(step(c, 'threshold').result).toBe(forecastRegion(region, inputs, context, { alertPercentile: 0.9 }).alertThreshold)
    expect(c.scope.mode).toBe('polygon')
    expect(ids(c)).toContain('polygon-approximation')
    expect(c.caveats.find((x) => x.id === 'exceedance-not-calibrated')?.params?.alertPercentile).toBe(0.9)
  })

  it('yearIndex fora do intervalo é limitado, sem throw', () => {
    expect(() => explainForecastYear(region, inputs, context, 99)).not.toThrow()
    expect(explainForecastYear(region, inputs, context, -3).history.highlightX).toBe(2027)
  })

  it('post-plan: passos reproduzem forecast.posts; tempo atual null sem postos existentes', () => {
    const forecast = forecastRegion(region, inputs, context)
    const c = explainPostPlan(region, inputs, context)
    expect(c.value.raw).toBe(forecast.posts.recommendedPosts)
    expect(step(c, 'coverage').result).toBe(forecast.posts.coverageMinPosts)
    expect(step(c, 'workload').result).toBe(forecast.posts.workloadPosts)
    expect(step(c, 'response').result).toBe(forecast.posts.recommendedMinutes)
    expect(step(c, 'current-response').result).toBeNull()
    expect(step(c, 'missing').result).toBe(forecast.posts.missingPosts)
    expect(ids(c)).toContain('placeholder-costs')
    const withPosts = explainPostPlan(region, { ...inputs, existingPosts: 2 }, context)
    expect(step(withPosts, 'current-response').result).toBe(forecastRegion(region, { ...inputs, existingPosts: 2 }, context).posts.currentMinutes)
  })
})

describe('correções de honestidade do "?"', () => {
  it('polígono desenhado sem sobreposição não cai no modo região', () => {
    const base = regionData()
    const empty = filterCalendar(base.regions!, YEARS, POLYGON_AB.map(([lon, lat]) => [lon + 100, lat + 50] as [number, number]), 'a', baseline)
    expect(empty.mode).toBe('empty')
    const data: ExplainData = { ...base, calendar: empty, polygonActive: true }
    expect(isPolygonWithoutOverlap(data)).toBe(true)
    const c = explainCalendarCell(data, 2024, 7)
    expect(c.scope.mode).toBe('polygon')
    expect(c.scope.regionId).toBeNull()
    expect(c.value.raw).toBeNull()
    expect(isPolygonWithoutOverlap({ ...base, polygonActive: false })).toBe(false)
  })

  it('not-operational só cita sobreposição quando factor=1 e incerteza nula ou >=100', () => {
    const shallow = explainCount(regionData({ factor: 1, uncertaintyPct: 100 }))
    expect(shallow.caveats.find((x) => x.id === 'not-operational')?.params?.cause).toBe('no-overlap')
    const low = explainCount(regionData({ factor: 1.3, uncertaintyPct: 30, confidence: 'low' }))
    expect(low.caveats.find((x) => x.id === 'not-operational')?.params?.cause).toBe('low-confidence')
  })

  it('insufficient-reference distingue projeção de valor descritivo', () => {
    const shortData = { ...regionData(), baseline: { from: 2023, to: 2024 } }
    const dashShort = { ...shortData, dashboard: dashboardForRegion(shortData.region!, { ...dashContext, baseline: shortData.baseline }, text) }
    expect(explainPeak(dashShort).caveats.find((x) => x.id === 'insufficient-reference')?.params?.kind).toBe('descriptive')
    const f = explainForecastYear(regionA(), DEFAULT_INPUTS, { currentYear: CURRENT_YEAR, baseline: { from: 2022, to: 2024 } }, 0)
    expect(f.caveats.find((x) => x.id === 'insufficient-reference')?.params?.kind).toBe('projection')
  })

  it('passos de faixa expõem mínimo e máximo observados', () => {
    const c = explainForecastYear(regionA(), DEFAULT_INPUTS, context, 0)
    const range = step(c, 'range')
    expect(range.values.observedMin).not.toBeNull()
    expect(range.values.observedMax).not.toBeNull()
    expect(range.values.observedMin as number).toBeLessThanOrEqual(range.values.p05 as number)
    expect(range.values.observedMax as number).toBeGreaterThanOrEqual(range.values.p95 as number)
    expect(step(explainCalendarCell(regionData(), 2024, 7), 'reference').values).toHaveProperty('observedMin')
  })

  it('forecast-year com n=0: limiar, faixa, chance e média são null, nunca 0', () => {
    const region = regionA({ baselineMeanAnnual: null } as never)
    const c = explainForecastYear(region, DEFAULT_INPUTS, { currentYear: CURRENT_YEAR, baseline: { from: 2030, to: 2031 } }, 0)
    expect(step(c, 'sample').result).toBe(0)
    for (const id of ['mean', 'expected', 'threshold', 'range', 'exceedance']) expect(step(c, id).result, id).toBeNull()
    expect(step(c, 'range').values.observedMin).toBeNull()
  })
})
