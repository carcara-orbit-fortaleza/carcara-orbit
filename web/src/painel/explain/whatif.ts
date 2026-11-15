// Camada "E se?" (nível 2): recalcula os números do painel sob WhatIfParams chamando as MESMAS
// funções de lib/ (forecastRegion, filterCalendar, dashboardForPolygon). Nada é reimplementado aqui:
// com os parâmetros atuais, `after` é idêntico a `before` (e ao cálculo original).
//
// Funções puras e sem exceção: entrada inválida volta como { ok: false, reason, issues };
// amostra insuficiente volta como `insufficient` preenchido (e os valores projetados em null).
import type { LonLat, RegionSeries } from '../types'
import { DEFAULT_ALERT_PERCENTILE, MIN_REFERENCE_YEARS, forecastRegion } from '../lib/forecast'
import type { CalcInputs, ForecastContext } from '../lib/forecast'
import { completeBaselineYears, dashboardForPolygon } from '../lib/dashboard'
import type { DashboardContext } from '../lib/dashboard'
import { filterCalendar } from '../lib/series'
import type { Baseline } from '../lib/series'
import type { PanelText } from '../lib/panelText'
import { explainForecastYear } from './builders'
import type { ForecastExplainOptions } from './builders'
import type { ExplainContext, WhatIfParams } from './types'

export const MIN_ALERT_PERCENTILE = 0.5
export const MAX_ALERT_PERCENTILE = 0.99
export const MAX_HORIZON_YEARS = 10
export const TREND_PCT_LIMIT = 1000

export type WhatIfIssueCode =
  | 'not-a-number' // parâmetro não finito: a chamada é recusada
  | 'baseline-order' // baselineFrom > baselineTo: a chamada é recusada
  | 'baseline-clamped' // ano de referência fora dos dados, limitado ao intervalo
  | 'percentile-clamped' // percentil fora de [0,5; 0,99], limitado
  | 'horizon-clamped' // ano-alvo fora de [atual+1, atual+10], limitado
  | 'trend-clamped' // tendência fora de ±TREND_PCT_LIMIT, limitada

export type WhatIfIssue = { code: WhatIfIssueCode; param: keyof WhatIfParams; requested: number | null; used: number | null }

/** Valores efetivos (já validados e limitados) usados no recálculo. */
export type EffectiveWhatIf = {
  baseline: Baseline
  alertPercentile: number
  /** undefined mantém a tendência original; null = "sem tendência" (fator 1). */
  trendPctDecade: number | null | undefined
  horizonYear: number
}

export type WhatIfBase = {
  baseline: Baseline
  alertPercentile: number
  currentYear: number
}

export type WhatIfInsufficient = { reason: 'insufficient-reference'; sampleYears: number; required: number }

export type WhatIfFailure = { ok: false; reason: 'invalid-params'; issues: WhatIfIssue[] }

/** after − before, campo a campo. null se qualquer lado é null (a diferença com "sem dado" não existe). */
export type Deltas<S> = { [K in keyof S]: S[K] extends number | null ? number | null : never }

function delta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before
}

function clampWithIssue(
  param: keyof WhatIfParams,
  value: number,
  min: number,
  max: number,
  code: WhatIfIssueCode,
  issues: WhatIfIssue[],
): number {
  const used = Math.min(max, Math.max(min, value))
  if (used !== value) issues.push({ code, param, requested: value, used })
  return used
}

/**
 * Valida e limita os parâmetros contra o estado atual. Recusa (ok:false) quando um número não é finito
 * ou a janela está invertida; limita (com `issues`) percentil, tendência, horizonte e anos fora dos dados.
 */
export function normalizeWhatIf(
  params: WhatIfParams,
  base: WhatIfBase & { trendPctDecade: number | null },
  dataYears: number[],
): { ok: true; value: EffectiveWhatIf; issues: WhatIfIssue[] } | WhatIfFailure {
  const issues: WhatIfIssue[] = []
  const numeric: Array<[keyof WhatIfParams, number | null | undefined]> = [
    ['baselineFrom', params.baselineFrom],
    ['baselineTo', params.baselineTo],
    ['alertPercentile', params.alertPercentile],
    ['horizonYear', params.horizonYear],
    ['trendPctDecade', params.trendPctDecade],
  ]
  for (const [param, value] of numeric) {
    if (value !== undefined && value !== null && !Number.isFinite(value)) {
      issues.push({ code: 'not-a-number', param, requested: null, used: null })
    }
  }
  if (issues.length) return { ok: false, reason: 'invalid-params', issues }

  const from = params.baselineFrom ?? base.baseline.from
  const to = params.baselineTo ?? base.baseline.to
  if (from > to) {
    return { ok: false, reason: 'invalid-params', issues: [{ code: 'baseline-order', param: 'baselineFrom', requested: from, used: null }] }
  }
  const minYear = dataYears.length ? Math.min(...dataYears) : from
  const maxYear = dataYears.length ? Math.max(...dataYears) : to
  const baseline: Baseline = {
    from: clampWithIssue('baselineFrom', from, minYear, maxYear, 'baseline-clamped', issues),
    to: clampWithIssue('baselineTo', to, minYear, maxYear, 'baseline-clamped', issues),
  }
  const alertPercentile = clampWithIssue('alertPercentile', params.alertPercentile ?? base.alertPercentile, MIN_ALERT_PERCENTILE, MAX_ALERT_PERCENTILE, 'percentile-clamped', issues)
  const horizonYear = Math.round(
    clampWithIssue('horizonYear', params.horizonYear ?? base.currentYear + 1, base.currentYear + 1, base.currentYear + MAX_HORIZON_YEARS, 'horizon-clamped', issues),
  )
  let trendPctDecade: number | null | undefined
  if (params.trendPctDecade === undefined) trendPctDecade = undefined
  else if (params.trendPctDecade === null) trendPctDecade = null
  else trendPctDecade = clampWithIssue('trendPctDecade', params.trendPctDecade, -TREND_PCT_LIMIT, TREND_PCT_LIMIT, 'trend-clamped', issues)
  return { ok: true, value: { baseline, alertPercentile, trendPctDecade, horizonYear }, issues }
}

// ---------------------------------------------------------------------------------------------
// Calculadora de cenários (forecast-year)
// ---------------------------------------------------------------------------------------------

/** Números do ano projetado. Com amostra insuficiente, os valores projetados são null (não são projeção). */
export type ForecastSnapshot = {
  sampleYears: number
  baselineFrom: number
  baselineTo: number
  baselineMean: number | null
  alertThreshold: number | null
  trendPctDecade: number | null
  alertPercentile: number
  year: number
  factor: number | null
  expected: number | null
  low: number | null
  high: number | null
  chanceAboveAlert: number | null
}

export type WhatIfForecastResult =
  | WhatIfFailure
  | {
      ok: true
      before: ForecastSnapshot
      after: ForecastSnapshot
      /** Só os campos numéricos que fazem sentido comparar. */
      deltas: Deltas<Pick<ForecastSnapshot, 'baselineMean' | 'alertThreshold' | 'factor' | 'expected' | 'low' | 'high' | 'chanceAboveAlert' | 'sampleYears'>>
      /** Preenchido quando a amostra do cenário "depois" é insuficiente. */
      insufficient: WhatIfInsufficient | null
      effective: EffectiveWhatIf
      issues: WhatIfIssue[]
      /** ExplainContext completos de antes e depois (para o painel reabrir o "?" no cenário). */
      contexts: { before: ExplainContext; after: ExplainContext }
    }

function snapshotOf(
  region: RegionSeries,
  inputs: CalcInputs,
  context: ForecastContext,
  yearIndex: number,
  alertPercentile: number,
): ForecastSnapshot {
  const forecast = forecastRegion(region, { ...inputs, horizonYears: Math.max(inputs.horizonYears, yearIndex + 1) }, context, { alertPercentile })
  const projection = forecast.years[Math.min(yearIndex, forecast.years.length - 1)]
  const ok = forecast.sufficient
  return {
    sampleYears: forecast.sampleYears,
    baselineFrom: context.baseline.from,
    baselineTo: context.baseline.to,
    baselineMean: ok ? forecast.baselineMean : null,
    alertThreshold: ok ? forecast.alertThreshold : null,
    trendPctDecade: forecast.trendPctDecade,
    alertPercentile,
    year: projection.year,
    factor: ok ? projection.factor : null,
    expected: ok ? projection.expected : null,
    low: ok ? projection.low : null,
    high: ok ? projection.high : null,
    chanceAboveAlert: ok ? projection.chanceAboveAlert : null,
  }
}

/**
 * Recalcula o ano `yearIndex` (padrão 0) da calculadora sob `params`. `before` usa o contexto atual
 * (`context`, `options.alertPercentile`, tendência da região); `after` aplica baseline, tendência,
 * percentil e ano-alvo (horizonYear, que substitui yearIndex quando informado).
 */
export function whatIfForecast(args: {
  region: RegionSeries
  inputs: CalcInputs
  context: ForecastContext
  params: WhatIfParams
  yearIndex?: number
  options?: ForecastExplainOptions
}): WhatIfForecastResult {
  const { region, inputs, context, params } = args
  const options = args.options ?? {}
  const beforePercentile = options.alertPercentile ?? DEFAULT_ALERT_PERCENTILE
  const beforeIndex = Math.max(0, Math.round(args.yearIndex ?? 0))
  const normalized = normalizeWhatIf(
    params,
    { baseline: context.baseline, alertPercentile: beforePercentile, currentYear: context.currentYear, trendPctDecade: region.metrics.trendPctDecade },
    region.annual.map((point) => point.year),
  )
  if (!normalized.ok) return normalized
  const effective = normalized.value
  const afterIndex = params.horizonYear === undefined ? beforeIndex : effective.horizonYear - (context.currentYear + 1)

  const afterRegion: RegionSeries =
    effective.trendPctDecade === undefined
      ? region
      : { ...region, metrics: { ...region.metrics, trendPctDecade: effective.trendPctDecade } }
  const afterContext: ForecastContext = { ...context, baseline: effective.baseline }
  const afterOptions: ForecastExplainOptions = { ...options, alertPercentile: effective.alertPercentile }

  const before = snapshotOf(region, inputs, context, beforeIndex, beforePercentile)
  const after = snapshotOf(afterRegion, inputs, afterContext, afterIndex, effective.alertPercentile)
  return {
    ok: true,
    before,
    after,
    deltas: {
      sampleYears: after.sampleYears - before.sampleYears,
      baselineMean: delta(before.baselineMean, after.baselineMean),
      alertThreshold: delta(before.alertThreshold, after.alertThreshold),
      factor: delta(before.factor, after.factor),
      expected: delta(before.expected, after.expected),
      low: delta(before.low, after.low),
      high: delta(before.high, after.high),
      chanceAboveAlert: delta(before.chanceAboveAlert, after.chanceAboveAlert),
    },
    insufficient:
      after.sampleYears < MIN_REFERENCE_YEARS
        ? { reason: 'insufficient-reference', sampleYears: after.sampleYears, required: MIN_REFERENCE_YEARS }
        : null,
    effective,
    issues: normalized.issues,
    contexts: {
      before: explainForecastYear(region, inputs, context, beforeIndex, options),
      after: explainForecastYear(afterRegion, inputs, afterContext, afterIndex, afterOptions),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Polígono: janela de referência
// ---------------------------------------------------------------------------------------------

/** Números do painel de polígono que dependem da janela de referência. null = sem dado, nunca 0. */
export type PolygonSnapshot = {
  baselineFrom: number
  baselineTo: number
  sampleYears: number
  baselineAnnual: number | null
  currentAnomaly: number | null
  peakTotal: number | null
  peakYear: number | null
  trend: number | null
}

export type WhatIfPolygonResult =
  | WhatIfFailure
  | {
      ok: true
      before: PolygonSnapshot
      after: PolygonSnapshot
      deltas: Deltas<Pick<PolygonSnapshot, 'baselineAnnual' | 'currentAnomaly' | 'peakTotal' | 'peakYear' | 'trend' | 'sampleYears'>>
      insufficient: WhatIfInsufficient | null
      effective: EffectiveWhatIf
      issues: WhatIfIssue[]
    }

/** Recalcula anomalia, pico, tendência e média de referência do polígono com outra janela (baselineFrom/To). */
export function whatIfPolygon(args: {
  regions: RegionSeries[]
  years: number[]
  polygon: LonLat[]
  context: DashboardContext
  hotspotInside: number
  text: PanelText
  params: WhatIfParams
}): WhatIfPolygonResult {
  const { regions, years, polygon, context, hotspotInside, text, params } = args
  const normalized = normalizeWhatIf(
    params,
    { baseline: context.baseline, alertPercentile: DEFAULT_ALERT_PERCENTILE, currentYear: context.currentYear, trendPctDecade: null },
    years,
  )
  if (!normalized.ok) return normalized
  const effective = normalized.value

  const snapshot = (baseline: Baseline): PolygonSnapshot => {
    const calendar = filterCalendar(regions, years, polygon, '', baseline)
    const dash = dashboardForPolygon(calendar, regions, hotspotInside, { ...context, baseline }, '', text)
    return {
      baselineFrom: baseline.from,
      baselineTo: baseline.to,
      sampleYears: completeBaselineYears(dash.annual, baseline).length,
      baselineAnnual: dash.baselineAnnual,
      currentAnomaly: dash.currentAnomaly,
      peakTotal: dash.peakTotal,
      peakYear: dash.peakYear,
      trend: dash.trend,
    }
  }
  const before = snapshot(context.baseline)
  const after = snapshot(effective.baseline)
  return {
    ok: true,
    before,
    after,
    deltas: {
      sampleYears: after.sampleYears - before.sampleYears,
      baselineAnnual: delta(before.baselineAnnual, after.baselineAnnual),
      currentAnomaly: delta(before.currentAnomaly, after.currentAnomaly),
      peakTotal: delta(before.peakTotal, after.peakTotal),
      peakYear: delta(before.peakYear, after.peakYear),
      trend: delta(before.trend, after.trend),
    },
    insufficient:
      after.sampleYears < MIN_REFERENCE_YEARS
        ? { reason: 'insufficient-reference', sampleYears: after.sampleYears, required: MIN_REFERENCE_YEARS }
        : null,
    effective,
    issues: normalized.issues,
  }
}
