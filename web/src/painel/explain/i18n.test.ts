import { describe, expect, it } from 'vitest'
import { messages } from '../../i18n/messages'
import { DEFAULT_INPUTS } from '../lib/forecast'
import { dashboardForPolygon, dashboardForRegion } from '../lib/dashboard'
import { filterCalendar } from '../lib/series'
import type { DatasetMeta } from '../types'
import {
  LABEL_KEYS,
  explainAnnual, explainAnomaly, explainCalendarCell, explainClimatology, explainConfidence, explainCount,
  explainForecastYear, explainMethodFactor, explainPeak, explainPostPlan, explainSensorMix, explainTrend,
} from './builders'
import type { ExplainData } from './builders'
import { CURRENT_YEAR, MONTHS, POLYGON_AB, YEARS, regionA, regionB, text } from './fixtures'
import type { CaveatId, ExplainContext } from './types'

// Todo id que os builders emitem precisa ter texto nos dois idiomas (o painel cai no id cru se faltar).
const baseline = { from: 2018, to: 2024 }
const context = { currentYear: CURRENT_YEAR, baseline }
const dashContext = { years: YEARS, currentYear: CURRENT_YEAR, baseline }
const meta = (mode: DatasetMeta['mode']): DatasetMeta => ({
  mode, methodVersion: 'm', datasetVersion: 'd', currentYear: CURRENT_YEAR, baselineFrom: 2018, baselineTo: 2024,
  calibrationWindow: '2018–2019', periodStart: '2018-01-01', periodEnd: '2026-10-31', lastCompleteYear: 2025, warnings: [],
})

function allContexts(): ExplainContext[] {
  const out: ExplainContext[] = []
  const region = regionA({ currentYearTotal: 3000, currentYearAnomaly: 12, peakYear: 2024, peakYearTotal: 1855, trendWindow: '2010–2020' })
  const shortBaseline = { from: 2022, to: 2024 }
  const regionData = (mode: DatasetMeta['mode'], base = baseline): ExplainData => ({
    meta: meta(mode), years: YEARS, months: MONTHS, currentYear: CURRENT_YEAR, baseline: base, region, regions: [region],
    dashboard: dashboardForRegion(region, { ...dashContext, baseline: base }, text),
  })
  const regions = [regionA({ factor: 1.2, uncertaintyPct: 40, confidence: 'medium' }), regionB({ factor: 1.4, uncertaintyPct: 60, confidence: 'medium' })]
  const calendar = filterCalendar(regions, YEARS, POLYGON_AB, 'a', baseline)
  const polygonData: ExplainData = {
    meta: meta('real'), years: YEARS, months: MONTHS, currentYear: CURRENT_YEAR, baseline, regions, calendar, region: null,
    dashboard: dashboardForPolygon(calendar, regions, 5, dashContext, '7d', text),
  }
  for (const data of [regionData('real'), regionData('mock'), regionData('real', shortBaseline), polygonData]) {
    out.push(
      explainCount(data), explainAnomaly(data), explainPeak(data), explainTrend(data), explainConfidence(data),
      explainSensorMix(data), explainMethodFactor(data), explainClimatology(data, 7), explainAnnual(data, 2024),
      explainCalendarCell(data, 2024, 7),
    )
  }
  for (const base of [baseline, shortBaseline]) {
    out.push(explainForecastYear(region, DEFAULT_INPUTS, { ...context, baseline: base }, 0, { meta: meta('mock') }))
    out.push(explainPostPlan(region, DEFAULT_INPUTS, { ...context, baseline: base }, { meta: meta('real') }))
  }
  return out
}

const CAVEATS: CaveatId[] = [
  'not-operational', 'mock-data', 'insufficient-reference', 'exceedance-not-calibrated', 'range-is-minmax',
  'polygon-approximation', 'trend-anchor', 'hotspot-proxy', 'sensor-mix', 'placeholder-costs',
]

describe('i18n do "?"', () => {
  const locales = Object.entries(messages) as Array<[string, Record<string, string>]>

  it('todo id emitido pelos builders tem texto em pt-BR e en', () => {
    const keys = new Set<string>(Object.values(LABEL_KEYS))
    for (const c of allContexts()) {
      keys.add(c.labelKey)
      keys.add(c.history.labelKey)
      for (const s of c.formula.steps) keys.add(`explain.step.${s.id}`)
      for (const w of c.whatChanges) keys.add(`explain.change.${w.id}`)
      for (const v of c.caveats) keys.add(`explain.caveat.${v.id}`)
    }
    for (const id of CAVEATS) keys.add(`explain.caveat.${id}`)
    for (const extra of ['insufficient-reference.descriptive', 'insufficient-reference.unknown', 'not-operational.no-overlap']) keys.add(`explain.caveat.${extra}`)
    for (const [locale, dictionary] of locales) {
      const missing = [...keys].filter((key) => typeof dictionary[key] !== 'string' || dictionary[key] === '')
      expect(missing, `chaves ausentes em ${locale}`).toEqual([])
    }
  })

  it('pt-BR e en têm o mesmo conjunto de chaves e os mesmos placeholders', () => {
    const pt = messages['pt-BR'] as Record<string, string>
    const en = messages.en as Record<string, string>
    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort())
    const holes = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    const diverging = Object.keys(pt).filter((key) => key.startsWith('explain') && holes(pt[key]) !== holes(en[key]))
    expect(diverging).toEqual([])
  })
})
