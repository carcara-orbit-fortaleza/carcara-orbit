// Liga explain/whatif.ts à tela: converte o resultado de whatIfForecast/whatIfPolygon em linhas
// "era X, agora Y". Nenhuma conta aqui: tudo vem das funções de lib/ via whatif.ts.
import type { CalcInputs, ForecastContext } from '../lib/forecast'
import type { DashboardContext } from '../lib/dashboard'
import type { PanelText } from '../lib/panelText'
import type { LonLat, RegionSeries } from '../types'
import type { ForecastExplainOptions } from './builders'
import type { WhatIfOutcome, WhatIfRow, WhatIfRunner } from './explainState'
import { whatIfForecast, whatIfPolygon } from './whatif'

function row(id: string, format: WhatIfRow['format'], before: number | null, after: number | null, delta: number | null): WhatIfRow {
  return { id, format, before, after, delta }
}

/** "E se?" do ano projetado na calculadora (forecast-year). */
export function forecastRunner(args: {
  region: RegionSeries
  inputs: CalcInputs
  context: ForecastContext
  yearIndex: number
  options?: ForecastExplainOptions
}): WhatIfRunner {
  return (params): WhatIfOutcome => {
    const result = whatIfForecast({ ...args, params })
    if (!result.ok) return { ok: false, issues: result.issues }
    const { before: b, after: a, deltas: d } = result
    return {
      ok: true,
      rows: [
        row('baselineMean', 'count', b.baselineMean, a.baselineMean, d.baselineMean),
        row('alertThreshold', 'count', b.alertThreshold, a.alertThreshold, d.alertThreshold),
        row('factor', 'factor', b.factor, a.factor, d.factor),
        row('expected', 'count', b.expected, a.expected, d.expected),
        row('low', 'count', b.low, a.low, d.low),
        row('high', 'count', b.high, a.high, d.high),
        row('chanceAboveAlert', 'share', b.chanceAboveAlert, a.chanceAboveAlert, d.chanceAboveAlert),
        row('sampleYears', 'years', b.sampleYears, a.sampleYears, d.sampleYears),
      ],
      insufficient: result.insufficient && { sampleYears: result.insufficient.sampleYears, required: result.insufficient.required },
      issues: result.issues,
    }
  }
}

/** "E se?" da janela de referência do polígono desenhado. */
export function polygonRunner(args: {
  regions: RegionSeries[]
  years: number[]
  polygon: LonLat[]
  context: DashboardContext
  hotspotInside: number
  text: PanelText
}): WhatIfRunner {
  return (params): WhatIfOutcome => {
    const result = whatIfPolygon({ ...args, params })
    if (!result.ok) return { ok: false, issues: result.issues }
    const { before: b, after: a, deltas: d } = result
    return {
      ok: true,
      rows: [
        row('baselineAnnual', 'count', b.baselineAnnual, a.baselineAnnual, d.baselineAnnual),
        row('currentAnomaly', 'percent', b.currentAnomaly, a.currentAnomaly, d.currentAnomaly),
        row('peakTotal', 'count', b.peakTotal, a.peakTotal, d.peakTotal),
        row('peakYear', 'year', b.peakYear, a.peakYear, d.peakYear),
        row('trend', 'percent', b.trend, a.trend, d.trend),
        row('sampleYears', 'years', b.sampleYears, a.sampleYears, d.sampleYears),
      ],
      insufficient: result.insufficient && { sampleYears: result.insufficient.sampleYears, required: result.insufficient.required },
      issues: result.issues,
    }
  }
}
