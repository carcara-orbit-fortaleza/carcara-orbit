import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUTS, forecastRegion } from '../lib/forecast'
import { dashboardForPolygon } from '../lib/dashboard'
import { filterCalendar } from '../lib/series'
import { explainForecastYear } from './builders'
import { normalizeWhatIf, whatIfForecast, whatIfPolygon } from './whatif'
import { CURRENT_YEAR, POLYGON_AB, YEARS, regionA, regionB, text } from './fixtures'

const baseline = { from: 2018, to: 2024 }
const context = { currentYear: CURRENT_YEAR, baseline }
const inputs = { ...DEFAULT_INPUTS, horizonYears: 5 }
const region = regionA({ trendPctDecade: 10 })

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true)
  return result as Extract<T, { ok: true }>
}

describe('normalizeWhatIf', () => {
  const base = { baseline, alertPercentile: 0.75, currentYear: CURRENT_YEAR, trendPctDecade: 10 }
  it('parâmetros vazios mantêm o estado atual', () => {
    const r = ok(normalizeWhatIf({}, base, YEARS))
    expect(r.value).toEqual({ baseline, alertPercentile: 0.75, trendPctDecade: undefined, horizonYear: 2027 })
    expect(r.issues).toEqual([])
  })
  it('recusa janela invertida e valores não finitos, sem lançar', () => {
    const inverted = normalizeWhatIf({ baselineFrom: 2024, baselineTo: 2019 }, base, YEARS)
    expect(inverted).toMatchObject({ ok: false, reason: 'invalid-params' })
    const nan = normalizeWhatIf({ alertPercentile: NaN }, base, YEARS)
    expect(nan).toMatchObject({ ok: false, issues: [{ code: 'not-a-number', param: 'alertPercentile' }] })
  })
  it('limita percentil, anos, horizonte e tendência, registrando cada ajuste', () => {
    const r = ok(normalizeWhatIf({ alertPercentile: 0.2, baselineFrom: 1990, baselineTo: 2100, horizonYear: 2100, trendPctDecade: 5000 }, base, YEARS))
    expect(r.value).toMatchObject({ alertPercentile: 0.5, baseline: { from: 2018, to: 2026 }, horizonYear: 2036, trendPctDecade: 1000 })
    expect(r.issues.map((i) => i.code).sort()).toEqual(['baseline-clamped', 'baseline-clamped', 'horizon-clamped', 'percentile-clamped', 'trend-clamped'])
    expect(ok(normalizeWhatIf({ alertPercentile: 1 }, base, YEARS)).value.alertPercentile).toBe(0.99)
    expect(ok(normalizeWhatIf({ trendPctDecade: null }, base, YEARS)).value.trendPctDecade).toBeNull()
  })
})

describe('whatIfForecast', () => {
  it('com parâmetros padrão, after == before == forecastRegion original', () => {
    const forecast = forecastRegion(region, inputs, context)
    const r = ok(whatIfForecast({ region, inputs, context, params: {} }))
    expect(r.after).toEqual(r.before)
    expect(r.before.expected).toBe(forecast.years[0].expected)
    expect(r.before.alertThreshold).toBe(forecast.alertThreshold)
    expect(r.before.chanceAboveAlert).toBe(forecast.years[0].chanceAboveAlert)
    expect(Object.values(r.deltas).every((d) => d === 0)).toBe(true)
    expect(r.insufficient).toBeNull()
    expect(r.contexts.after).toEqual(r.contexts.before)
    expect(r.contexts.before).toEqual(explainForecastYear(region, inputs, context, 0))
  })

  it('valores explícitos iguais aos atuais também não mudam nada', () => {
    const r = ok(whatIfForecast({ region, inputs, context, params: { baselineFrom: 2018, baselineTo: 2024, alertPercentile: 0.75, trendPctDecade: 10, horizonYear: 2027 } }))
    expect(r.after).toEqual(r.before)
  })

  it('percentil, tendência e horizonte batem com a função real chamada à mão', () => {
    const r = ok(whatIfForecast({ region, inputs, context, params: { alertPercentile: 0.9, trendPctDecade: 40, horizonYear: 2030 } }))
    const manual = forecastRegion({ ...region, metrics: { ...region.metrics, trendPctDecade: 40 } }, inputs, context, { alertPercentile: 0.9 })
    const y = manual.years[3]
    expect(r.after.year).toBe(2030)
    expect(r.after.expected).toBe(y.expected)
    expect(r.after.factor).toBe(y.factor)
    expect(r.after.alertThreshold).toBe(manual.alertThreshold)
    expect(r.after.chanceAboveAlert).toBe(y.chanceAboveAlert)
    expect(r.deltas.expected).toBe((y.expected as number) - (r.before.expected as number))
    expect(r.contexts.after.value.raw).toBe(y.expected)
    expect(r.contexts.after.whatIf?.current.alertPercentile).toBe(0.9)
    expect(r.contexts.before.whatIf?.current.alertPercentile).toBe(0.75)
  })

  it('tendência null explícita zera o efeito (fator 1) sem virar 0 no snapshot', () => {
    const r = ok(whatIfForecast({ region, inputs, context, params: { trendPctDecade: null } }))
    expect(r.after.trendPctDecade).toBeNull()
    expect(r.after.factor).toBe(1)
  })

  it('nova janela com amostra insuficiente: estrutura, sem throw, valores null e deltas null', () => {
    const r = ok(whatIfForecast({ region, inputs, context, params: { baselineFrom: 2022, baselineTo: 2024 } }))
    expect(r.insufficient).toEqual({ reason: 'insufficient-reference', sampleYears: 3, required: 5 })
    expect(r.after.expected).toBeNull()
    expect(r.after.alertThreshold).toBeNull()
    expect(r.deltas.expected).toBeNull()
    expect(r.deltas.sampleYears).toBe(-3)
    expect(r.contexts.after.value.raw).toBeNull()
    expect(r.contexts.after.caveats.map((c) => c.id)).toContain('insufficient-reference')
    expect(r.before.expected).not.toBeNull()
  })

  it('entrada inválida volta estruturada', () => {
    expect(whatIfForecast({ region, inputs, context, params: { baselineFrom: 2024, baselineTo: 2020 } })).toMatchObject({ ok: false })
  })
})

describe('whatIfPolygon', () => {
  const regions = [regionA({ factor: 1.2, uncertaintyPct: 40 }), regionB({ factor: 1.4, uncertaintyPct: 60 })]
  const dashContext = { years: YEARS, currentYear: CURRENT_YEAR, baseline }
  const args = { regions, years: YEARS, polygon: POLYGON_AB, context: dashContext, hotspotInside: 0, text }

  it('padrão: before == after == dashboardForPolygon', () => {
    const r = ok(whatIfPolygon({ ...args, params: {} }))
    expect(r.after).toEqual(r.before)
    const calendar = filterCalendar(regions, YEARS, POLYGON_AB, 'x', baseline)
    const dash = dashboardForPolygon(calendar, regions, 0, dashContext, '', text)
    expect(r.before.currentAnomaly).toBe(dash.currentAnomaly)
    expect(r.before.trend).toBe(dash.trend)
    expect(r.before.peakTotal).toBe(dash.peakTotal)
    expect(r.before.baselineAnnual).toBe(dash.baselineAnnual)
  })

  it('janela curta: tendência vira null, insuficiente estruturado, deltas null', () => {
    const r = ok(whatIfPolygon({ ...args, params: { baselineFrom: 2022, baselineTo: 2024 } }))
    expect(r.after.trend).toBeNull()
    expect(r.after.sampleYears).toBe(3)
    expect(r.insufficient?.reason).toBe('insufficient-reference')
    expect(r.deltas.trend).toBeNull()
    expect(r.before.trend).not.toBeNull()
  })

  it('janela diferente muda a anomalia como a função real', () => {
    const r = ok(whatIfPolygon({ ...args, params: { baselineFrom: 2019, baselineTo: 2025 } }))
    const b = { from: 2019, to: 2025 }
    const calendar = filterCalendar(regions, YEARS, POLYGON_AB, 'x', b)
    const dash = dashboardForPolygon(calendar, regions, 0, { ...dashContext, baseline: b }, '', text)
    expect(r.after.currentAnomaly).toBe(dash.currentAnomaly)
    expect(r.deltas.currentAnomaly).toBe((dash.currentAnomaly as number) - (r.before.currentAnomaly as number))
  })
})
