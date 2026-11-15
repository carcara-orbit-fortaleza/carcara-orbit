// Construtores puros do contexto do "?" (ExplainContext). Recebem dados simples (nada de React nem i18n)
// e devolvem números CRUS. Toda conta passa pelas mesmas funções de lib/ que alimentam a tela
// (forecast, dashboard, series, stats): a explicação não tem matemática própria que possa divergir.
//
// Regras:
//  - null é "sem dado" e nunca vira 0 (o passo mostra null; o resultado fica null).
//  - Em modo região, valores pré-calculados pela API (pico, tendência, anomalia, confiança, incerteza,
//    climatologia) usam formula.derivedBy='api' com um passo único que cita a methodVersion.
//  - Estado raso do dataset (fator 1, incerteza 100%, confiança baixa) é estado normal: vira a
//    ressalva 'not-operational', não erro.
import type { AnnualPoint, DatasetMeta, RegionSeries } from '../types'
import {
  baselineSampleTrace,
  exceedance,
  forecastRegion,
  MAX_FACTOR,
  MIN_FACTOR,
  MIN_REFERENCE_YEARS,
  peakMonthlyExpectedOf,
  ringAreaKm2,
  responseMinutes,
  ROAD_FACTOR,
  SMALL_SAMPLE_N,
  trendFactorTrace,
  DEFAULT_ALERT_PERCENTILE,
  RANGE_HIGH_P,
  RANGE_LOW_P,
} from '../lib/forecast'
import type { CalcInputs, Forecast, ForecastContext, ForecastOptions } from '../lib/forecast'
import {
  annualSeries,
  climatologyTraceOf,
  completeBaselineYears,
  currentYearAnomalyTrace,
  sensorMix,
  trendTrace,
} from '../lib/dashboard'
import type { Dashboard } from '../lib/dashboard'
import { anomalyMatrix, blendCell, referenceValues } from '../lib/series'
import type { Baseline, FilteredCalendar } from '../lib/series'
import { mean, percentile } from '../lib/stats'
import type {
  CaveatId,
  ExplainCaveat,
  ExplainContext,
  ExplainHistoryPoint,
  ExplainKind,
  ExplainScalar,
  ExplainStep,
  ExplainWhatChanges,
  ExplainWhatIfSpec,
} from './types'

// ---------------------------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------------------------

/**
 * Dados que a UI já tem em mãos para os builders baseados no painel (KPIs, calendário, séries).
 * O modo é 'polygon' quando `calendar.mode === 'polygon'`; caso contrário é 'region'.
 */
export type ExplainData = {
  /** Metadados do dataset (workspace.meta). null => datasetMode 'unknown'. */
  meta: DatasetMeta | null
  /** Anos do calendário (workspace.years). */
  years: number[]
  /** Rótulos curtos dos 12 meses, no idioma exibido (usados só como x do histórico). */
  months: string[]
  currentYear: number
  baseline: Baseline
  /** O Dashboard que a tela exibe (dashboardForRegion ou dashboardForPolygon). */
  dashboard: Dashboard
  /** Região selecionada. Obrigatória em modo região. */
  region?: RegionSeries | null
  /** Calendário filtrado (filterCalendar). Obrigatório em modo polígono. */
  calendar?: FilteredCalendar | null
  /** Todas as regiões do workspace. Obrigatório em modo polígono (fator e incerteza ponderados). */
  regions?: RegionSeries[]
  /** Percentil do limiar de alerta em uso (padrão DEFAULT_ALERT_PERCENTILE). Entra no whatIf. */
  alertPercentile?: number
  /** true quando há um polígono desenhado, mesmo sem sobreposição (calendar.mode 'empty'): nunca cair no modo região. */
  polygonActive?: boolean
}

/** Opções dos builders baseados na calculadora (forecast-year e post-plan). */
export type ForecastExplainOptions = {
  meta?: DatasetMeta | null
  /** Percentil do limiar de alerta (repassado a forecastRegion). */
  alertPercentile?: number
  /** Presente quando `region` é uma série sintética de polígono. */
  polygon?: { name: string; weights: Array<{ regionId: string; weight: number }> }
}

export const LABEL_KEYS = {
  count: 'panelKpiCount',
  anomaly: 'panelKpiAnomaly',
  peak: 'panelKpiPeak',
  trend: 'panelKpiTrend',
  confidence: 'panelConfidenceLabel',
  sensorMix: 'panelSensorMix',
  methodFactor: 'panelMethod',
  climatology: 'panelClimatologyTitle',
  annual: 'panelAnnualTitle',
  calendarCell: 'panelCalendarCell',
  forecastYear: 'panelForecastYear',
  postPlan: 'panelPostsResponse',
} as const

const HISTORY_KEYS = {
  annual: 'explainHistoryAnnual',
  monthly: 'explainHistoryMonthlyClimatology',
  cellYears: 'explainHistoryCellAcrossYears',
  sensor: 'explainHistoryModisShareByYear',
  projection: 'explainHistoryAnnualWithProjection',
  none: 'explainHistoryNone',
} as const

// ---------------------------------------------------------------------------------------------
// Predicado "não operacional"
// ---------------------------------------------------------------------------------------------

/**
 * Predicado ÚNICO de "calibração ausente" (ressalva 'not-operational').
 *
 * Verdadeiro quando QUALQUER uma destas vale:
 *  - sem calibração: fator === 1 E (incerteza === null OU incerteza >= 100). É o estado do dataset
 *    só-NRT: sem sobreposição MODIS/VIIRS não há fator estimado, e incerteza 100% significa "sem régua".
 *    Incerteza null é tratada como desconhecida, logo também não calibrada (conservador).
 *  - confiança === 'low'.
 * O caso "estimated sem sobreposição" (confiança fixa do polígono) cai no primeiro item, porque a
 * confiança 'estimated' sozinha não prova calibração: só fator ≠ 1 ou incerteza < 100 prova.
 */
export function isNotOperational(input: { factor: number; uncertaintyPct: number | null; confidence: string | null }): boolean {
  const noCalibration = input.factor === 1 && (input.uncertaintyPct === null || input.uncertaintyPct >= 100)
  return noCalibration || input.confidence === 'low'
}

// ---------------------------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------------------------

type Mode = 'region' | 'polygon'

function modeOf(data: ExplainData): Mode {
  return data.calendar?.mode === 'polygon' || data.polygonActive === true ? 'polygon' : 'region'
}

/** Polígono desenhado que não sobrepõe nenhuma região: não há dado a explicar (e a região escolhida não vale). */
export function isPolygonWithoutOverlap(data: ExplainData): boolean {
  return data.polygonActive === true && data.calendar?.mode !== 'polygon'
}

/** Mínimo e máximo observados da amostra; null quando não há amostra (nunca 0). */
function observedRange(values: number[]): { observedMin: number | null; observedMax: number | null } {
  return values.length ? { observedMin: Math.min(...values), observedMax: Math.max(...values) } : { observedMin: null, observedMax: null }
}

const EMPTY_GRID: (number | null)[][] = []

function countsOf(data: ExplainData): (number | null)[][] {
  if (modeOf(data) === 'polygon') return data.calendar?.counts ?? EMPTY_GRID
  return data.region?.counts ?? EMPTY_GRID
}

function activeWeights(data: ExplainData) {
  return (data.calendar?.weights ?? []).filter((weight) => weight.weight > 0)
}

function listOf(values: Array<number | string>): string {
  return values.join(',')
}

function sourceOf(
  meta: DatasetMeta | null | undefined,
  sensors: string[],
  baseline: Baseline | null,
): ExplainContext['source'] {
  return {
    datasetMode: meta?.mode ?? 'unknown',
    methodVersion: meta?.methodVersion ?? null,
    datasetVersion: meta?.datasetVersion ?? null,
    sensors,
    period: meta?.periodStart && meta.periodEnd ? `${meta.periodStart}/${meta.periodEnd}` : null,
    baseline,
  }
}

function sensorsOf(dash: Pick<Dashboard, 'modisRaw' | 'viirsRaw'>): string[] {
  const sensors: string[] = []
  if (dash.modisRaw > 0) sensors.push('MODIS')
  if (dash.viirsRaw > 0) sensors.push('VIIRS')
  return sensors
}

function scopeOf(data: ExplainData): ExplainContext['scope'] {
  if (modeOf(data) === 'polygon') {
    return {
      mode: 'polygon',
      regionId: null,
      regionName: data.dashboard.name,
      weights: activeWeights(data).map((weight) => ({ regionId: weight.id, weight: weight.weight })),
    }
  }
  return { mode: 'region', regionId: data.region?.id ?? null, regionName: data.region?.name ?? data.dashboard.name }
}

/** Rótulo do intervalo: com amostra pequena, P05–P95 equivale a mínimo–máximo. */
function intervalLabel(n: number | null): 'p05-p95' | 'min-max' {
  return n !== null && n < SMALL_SAMPLE_N ? 'min-max' : 'p05-p95'
}

type CaveatFlags = {
  mode: Mode
  mock: boolean
  calibration: { factor: number; uncertaintyPct: number | null; confidence: string | null }
  polygonRegions?: number
  /** Tamanho da amostra de referência; undefined = a ressalva de amostra não se aplica a este dado. */
  sample?: number | null
  /** 'projection' = o valor projetado deixa de existir; 'descriptive' = há valor exibido, só a comparação é fraca. */
  sampleKind?: 'projection' | 'descriptive'
  interval?: { n: number | null } | null
  exceedance?: { alertPercentile: number } | null
  trendAnchor?: { anchorYear: number; apiWindow: string | null } | null
  hotspot?: boolean
  sensor?: boolean
  costs?: boolean
}

/** Monta as ressalvas na ordem fixa do contrato. */
function caveatsOf(flags: CaveatFlags): ExplainCaveat[] {
  const list: ExplainCaveat[] = []
  const add = (id: CaveatId, params?: Record<string, ExplainScalar>) => list.push(params ? { id, params } : { id })
  if (flags.mock) add('mock-data')
  if (isNotOperational(flags.calibration)) {
    const { factor, uncertaintyPct, confidence } = flags.calibration
    const noOverlap = factor === 1 && (uncertaintyPct === null || uncertaintyPct >= 100)
    add('not-operational', { factor, uncertaintyPct, confidence, cause: noOverlap ? 'no-overlap' : 'low-confidence' })
  }
  if (flags.mode === 'polygon') add('polygon-approximation', { regions: flags.polygonRegions ?? null })
  if (flags.sample !== undefined && (flags.sample === null || flags.sample < MIN_REFERENCE_YEARS)) {
    add('insufficient-reference', { n: flags.sample, required: MIN_REFERENCE_YEARS, kind: flags.sampleKind ?? 'descriptive' })
  }
  if (flags.interval && intervalLabel(flags.interval.n) === 'min-max') add('range-is-minmax', { n: flags.interval.n })
  if (flags.exceedance) add('exceedance-not-calibrated', { alertPercentile: flags.exceedance.alertPercentile })
  if (flags.trendAnchor) add('trend-anchor', { anchorYear: flags.trendAnchor.anchorYear, apiWindow: flags.trendAnchor.apiWindow })
  if (flags.hotspot) add('hotspot-proxy')
  if (flags.sensor) add('sensor-mix')
  if (flags.costs) add('placeholder-costs')
  return list
}

function dashCalibration(dash: Dashboard) {
  return { factor: dash.factor, uncertaintyPct: dash.uncertainty, confidence: dash.confidence }
}

function annualPoints(annual: AnnualPoint[]): ExplainHistoryPoint[] {
  return annual.map((point) => ({ x: point.year, y: point.total, partial: point.partial }))
}

function whatIfSpecBaseline(data: ExplainData): ExplainWhatIfSpec {
  return {
    controls: ['baseline'],
    current: {
      baselineFrom: data.baseline.from,
      baselineTo: data.baseline.to,
      alertPercentile: data.alertPercentile ?? DEFAULT_ALERT_PERCENTILE,
    },
  }
}

type Draft = {
  kind: ExplainKind
  labelKey: string
  value: ExplainContext['value']
  derivedBy: 'client' | 'api'
  steps: ExplainStep[]
  uncertainty: ExplainContext['uncertainty']
  history: ExplainContext['history']
  whatChanges: ExplainWhatChanges[]
  caveats: ExplainCaveat[]
  whatIf?: ExplainWhatIfSpec
}

function assemble(data: ExplainData, draft: Draft): ExplainContext {
  const context: ExplainContext = {
    schema: 1,
    kind: draft.kind,
    labelKey: draft.labelKey,
    scope: scopeOf(data),
    value: draft.value,
    source: sourceOf(data.meta, sensorsOf(data.dashboard), data.baseline),
    formula: { derivedBy: draft.derivedBy, steps: draft.steps },
    uncertainty: draft.uncertainty,
    history: draft.history,
    whatChanges: draft.whatChanges,
    caveats: draft.caveats,
  }
  if (draft.whatIf) context.whatIf = draft.whatIf
  return context
}

function noInterval(data: ExplainData, sampleSize: number | null): ExplainContext['uncertainty'] {
  return {
    pct: data.dashboard.uncertainty,
    confidence: data.dashboard.confidence,
    sampleSize,
    interval: { low: null, high: null, label: 'none' },
  }
}

function caveatBase(data: ExplainData): Pick<CaveatFlags, 'mode' | 'mock' | 'calibration' | 'polygonRegions'> {
  return {
    mode: modeOf(data),
    mock: data.meta?.mode === 'mock',
    calibration: dashCalibration(data.dashboard),
    polygonRegions: activeWeights(data).length,
  }
}

/** Passo único de valor vindo pronto da API (derivedBy='api'). Não inventa derivação. */
function apiStep(data: ExplainData, id: string, expr: string, values: Record<string, ExplainScalar>, result: ExplainScalar, unit?: string): ExplainStep {
  const step: ExplainStep = { id, expr, values: { methodVersion: data.meta?.methodVersion ?? null, ...values }, result }
  if (unit) step.unit = unit
  return step
}

function step(id: string, expr: string, values: Record<string, ExplainScalar>, result: ExplainScalar, unit?: string): ExplainStep {
  const out: ExplainStep = { id, expr, values, result }
  if (unit) out.unit = unit
  return out
}

function weightValues(data: ExplainData): Record<string, ExplainScalar> {
  const values: Record<string, ExplainScalar> = {}
  for (const weight of activeWeights(data)) values[`w_${weight.id}`] = weight.weight
  return values
}

function metricOf(data: ExplainData, id: string) {
  return data.regions?.find((region) => region.id === id)?.metrics ?? null
}

/** Anos completos da janela de referência (a amostra), nos dois modos. */
function referenceYearsOf(data: ExplainData): { years: number[]; values: number[] } {
  if (modeOf(data) === 'polygon') {
    const points = completeBaselineYears(data.dashboard.annual, data.baseline)
    return { years: points.map((point) => point.year), values: points.map((point) => point.total) }
  }
  if (!data.region) return { years: [], values: [] }
  const trace = baselineSampleTrace(data.region, data.baseline)
  return { years: trace.years, values: trace.values }
}

// ---------------------------------------------------------------------------------------------
// 1. Contagem
// ---------------------------------------------------------------------------------------------

/** KPI "focos no ano corrente". Região: valor da API. Polígono: soma ponderada das células do ano corrente. */
export function explainCount(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  const polygon = modeOf(data) === 'polygon'
  const steps: ExplainStep[] = polygon
    ? [
        step('weights', 'peso_r = área(polígono ∩ região r) / área(região r)', weightValues(data), activeWeights(data).length),
        step(
          'sum',
          'Σ_meses Σ_regiões peso × focos(região, mês)',
          { year: data.currentYear, months: dash.currentMonthsLabel || null, regions: activeWeights(data).length },
          dash.currentTotal,
          'hotspots',
        ),
      ]
    : [apiStep(data, 'api-value', 'N = Σ hotspots(year, months)', { year: data.currentYear, months: dash.currentMonthsLabel || null }, dash.currentTotal, 'hotspots')]
  return assemble(data, {
    kind: 'kpi-count',
    labelKey: LABEL_KEYS.count,
    value: { raw: dash.currentTotal, unit: 'hotspots' },
    derivedBy: polygon ? 'client' : 'api',
    steps,
    uncertainty: noInterval(data, null),
    history: { labelKey: HISTORY_KEYS.annual, points: annualPoints(dash.annual), highlightX: data.currentYear },
    whatChanges: [{ id: 'new-data', params: { year: data.currentYear } }, { id: 'calibration' }, ...(polygon ? [{ id: 'polygon-shape' }] : [])],
    caveats: caveatsOf({ ...caveatBase(data), hotspot: true }),
  })
}

// ---------------------------------------------------------------------------------------------
// 2. Anomalia
// ---------------------------------------------------------------------------------------------

/** KPI de anomalia do ano corrente contra a média dos mesmos meses nos anos de referência. */
export function explainAnomaly(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  const polygon = modeOf(data) === 'polygon'
  const trace = currentYearAnomalyTrace(countsOf(data), data.years, data.currentYear, data.baseline)
  const n = trace.perMonth.length ? Math.min(...trace.perMonth.map((item) => item.referenceYears.length)) : null
  const steps: ExplainStep[] = polygon
    ? [
        step('reference', 'Σ_meses média_referência(mês)', { months: trace.monthsUsed.length, monthsUsed: listOf(trace.monthsUsed.map((month) => data.months[month] ?? month)), baselineFrom: data.baseline.from, baselineTo: data.baseline.to }, trace.monthsUsed.length ? trace.reference : null, 'hotspots'),
        step('current', 'Σ_meses focos(ano corrente)', { year: data.currentYear, months: trace.monthsUsed.length }, trace.monthsUsed.length ? trace.current : null, 'hotspots'),
        step('anomaly', '(atual − referência) / referência × 100', { current: trace.monthsUsed.length ? trace.current : null, reference: trace.monthsUsed.length ? trace.reference : null }, dash.currentAnomaly, '%'),
      ]
    : [apiStep(data, 'api-value', 'anomaly = (current − reference) / reference × 100', { year: data.currentYear, baselineFrom: data.baseline.from, baselineTo: data.baseline.to }, dash.currentAnomaly, '%')]
  return assemble(data, {
    kind: 'kpi-anomaly',
    labelKey: LABEL_KEYS.anomaly,
    value: { raw: dash.currentAnomaly, unit: '%' },
    derivedBy: polygon ? 'client' : 'api',
    steps,
    uncertainty: noInterval(data, n),
    history: { labelKey: HISTORY_KEYS.annual, points: annualPoints(dash.annual), highlightX: data.currentYear },
    whatChanges: [{ id: 'baseline-window' }, { id: 'new-data', params: { year: data.currentYear } }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sample: n, hotspot: true }),
    whatIf: polygon ? whatIfSpecBaseline(data) : undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// 3. Pico
// ---------------------------------------------------------------------------------------------

/** KPI "pico histórico": maior total anual completo da janela de referência. */
export function explainPeak(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  const polygon = modeOf(data) === 'polygon'
  const reference = referenceYearsOf(data)
  const n = reference.years.length
  const steps: ExplainStep[] = polygon
    ? [
        step('sample', 'anos completos da janela de referência', { baselineFrom: data.baseline.from, baselineTo: data.baseline.to, n, years: listOf(reference.years) }, n),
        step('max', 'máx(total anual completo)', { n, peakYear: dash.peakYear }, dash.peakTotal, 'hotspots'),
      ]
    : [apiStep(data, 'api-value', 'peak = max(complete annual totals)', { peakYear: dash.peakYear }, dash.peakTotal, 'hotspots')]
  return assemble(data, {
    kind: 'kpi-peak',
    labelKey: LABEL_KEYS.peak,
    value: { raw: dash.peakTotal, unit: 'hotspots' },
    derivedBy: polygon ? 'client' : 'api',
    steps,
    uncertainty: noInterval(data, n),
    history: { labelKey: HISTORY_KEYS.annual, points: annualPoints(dash.annual), highlightX: dash.peakYear ?? undefined },
    whatChanges: [{ id: 'baseline-window' }, { id: 'new-year-complete' }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sample: n, hotspot: true }),
    whatIf: polygon ? whatIfSpecBaseline(data) : undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// 4. Tendência
// ---------------------------------------------------------------------------------------------

/** KPI de tendência linear (% da média por década). */
export function explainTrend(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  const polygon = modeOf(data) === 'polygon'
  const reference = referenceYearsOf(data)
  const n = reference.years.length
  const trace = trendTrace(reference.years.map((year, index) => ({ year, total: reference.values[index] })))
  const steps: ExplainStep[] = polygon
    ? [
        step('sample', 'anos completos da janela de referência', { baselineFrom: data.baseline.from, baselineTo: data.baseline.to, n, years: listOf(reference.years) }, n),
        step('mean', 'média(total anual)', { n }, trace.reason === 'insufficient-reference' ? null : trace.meanY, 'hotspots'),
        step('slope', 'inclinação de mínimos quadrados (focos/ano)', { n, reason: trace.reason }, trace.slopePerYear, 'hotspots/year'),
        step('trend', 'inclinação × 10 / média × 100', { slope: trace.slopePerYear, mean: trace.reason === 'insufficient-reference' ? null : trace.meanY }, dash.trend, '%/decade'),
      ]
    : [apiStep(data, 'api-value', 'trend = OLS slope / mean × 10 yr (%)', { trendWindow: dash.trendWindow }, dash.trend, '%/decade')]
  const windowDiffers = dash.trendWindow !== `${data.baseline.from}–${data.baseline.to}`
  return assemble(data, {
    kind: 'kpi-trend',
    labelKey: LABEL_KEYS.trend,
    value: { raw: dash.trend, unit: '%/decade' },
    derivedBy: polygon ? 'client' : 'api',
    steps,
    uncertainty: noInterval(data, n),
    history: { labelKey: HISTORY_KEYS.annual, points: annualPoints(dash.annual), highlightX: undefined },
    whatChanges: [{ id: 'baseline-window' }, { id: 'new-year-complete' }, { id: 'calibration' }],
    caveats: caveatsOf({
      ...caveatBase(data),
      sample: n,
      trendAnchor: !polygon && windowDiffers ? { anchorYear: data.baseline.to, apiWindow: dash.trendWindow } : null,
      hotspot: true,
      sensor: true,
    }),
    whatIf: polygon ? whatIfSpecBaseline(data) : undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// 5. Confiança e 7. Fator do método (compartilham a calibração ponderada)
// ---------------------------------------------------------------------------------------------

function calibrationSteps(data: ExplainData): ExplainStep[] {
  const dash = data.dashboard
  const notOperational = isNotOperational(dashCalibration(dash))
  const check = step(
    'operational-check',
    'não operacional = (fator = 1 E incerteza ≥ 100%) OU confiança = baixa',
    { factor: dash.factor, uncertaintyPct: dash.uncertainty, confidence: dash.confidence },
    notOperational,
  )
  if (modeOf(data) === 'polygon') {
    const values: Record<string, ExplainScalar> = {}
    for (const weight of activeWeights(data)) {
      const metrics = metricOf(data, weight.id)
      values[`w_${weight.id}`] = weight.weight
      values[`factor_${weight.id}`] = metrics?.factor ?? 1
      values[`uncertainty_${weight.id}`] = metrics?.uncertaintyPct ?? null
    }
    return [
      step('factor', 'Σ peso × fator / Σ peso', values, dash.factor, 'x'),
      step('uncertainty', 'Σ peso × incerteza / Σ peso (null se alguma região não tem incerteza)', values, dash.uncertainty, '%'),
      step('confidence', 'confiança do polígono é fixa', { confidence: dash.confidence }, dash.confidence),
      check,
    ]
  }
  return [
    apiStep(data, 'api-value', 'fator, incerteza e confiança da harmonização MODIS/VIIRS (valores da API)', {
      factor: dash.factor,
      uncertaintyPct: dash.uncertainty,
      confidence: dash.confidence,
      calibrationWindow: data.meta?.calibrationWindow ?? null,
    }, dash.factor, 'x'),
    check,
  ]
}

/** Confiança da harmonização. value.raw é a incerteza (%), o nível textual está em uncertainty.confidence. */
export function explainConfidence(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  return assemble(data, {
    kind: 'confidence',
    labelKey: LABEL_KEYS.confidence,
    value: { raw: dash.uncertainty, unit: '%' },
    derivedBy: modeOf(data) === 'polygon' ? 'client' : 'api',
    steps: calibrationSteps(data),
    uncertainty: noInterval(data, null),
    history: { labelKey: HISTORY_KEYS.none, points: [] },
    whatChanges: [{ id: 'calibration' }, { id: 'overlap-window', params: { calibrationWindow: data.meta?.calibrationWindow ?? null } }],
    caveats: caveatsOf({ ...caveatBase(data), sensor: true }),
  })
}

/** Fator de calibração do método (sensibilidade MODIS vs VIIRS). */
export function explainMethodFactor(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  return assemble(data, {
    kind: 'method-factor',
    labelKey: LABEL_KEYS.methodFactor,
    value: { raw: dash.factor, unit: 'x' },
    derivedBy: modeOf(data) === 'polygon' ? 'client' : 'api',
    steps: calibrationSteps(data),
    uncertainty: noInterval(data, null),
    history: { labelKey: HISTORY_KEYS.none, points: [] },
    whatChanges: [{ id: 'calibration' }, { id: 'overlap-window', params: { calibrationWindow: data.meta?.calibrationWindow ?? null } }],
    caveats: caveatsOf({ ...caveatBase(data), sensor: true }),
  })
}

// ---------------------------------------------------------------------------------------------
// 6. Mistura de sensores
// ---------------------------------------------------------------------------------------------

/**
 * Participação do MODIS nos focos brutos (value.raw, %). Sem detecção alguma (MODIS + VIIRS = 0)
 * a participação é null: não existe proporção, e 0% seria uma afirmação falsa.
 */
export function explainSensorMix(data: ExplainData): ExplainContext {
  const dash = data.dashboard
  const polygon = modeOf(data) === 'polygon'
  const total = dash.modisRaw + dash.viirsRaw
  const modisShare = total === 0 ? null : (dash.modisRaw / total) * 100
  const viirsShare = total === 0 ? null : (dash.viirsRaw / total) * 100
  const modisGrid = polygon ? data.calendar?.rawModis : data.region?.rawModis
  const viirsGrid = polygon ? data.calendar?.rawViirs : data.region?.rawViirs
  const points: ExplainHistoryPoint[] = data.years.map((year, index) => {
    const row = sensorMix(modisGrid ? [modisGrid[index] ?? []] : [], viirsGrid ? [viirsGrid[index] ?? []] : [])
    const known = [...(modisGrid?.[index] ?? []), ...(viirsGrid?.[index] ?? [])].some((value) => value !== null)
    const sum = row.modisRaw + row.viirsRaw
    return { x: year, y: known && sum > 0 ? (row.modisRaw / sum) * 100 : null }
  })
  return assemble(data, {
    kind: 'sensor-mix',
    labelKey: LABEL_KEYS.sensorMix,
    value: { raw: modisShare, unit: '%' },
    derivedBy: 'client',
    steps: [
      step('sum-raw', 'Σ focos brutos por sensor (todos os anos e meses)', { modisRaw: dash.modisRaw, viirsRaw: dash.viirsRaw }, total, 'hotspots'),
      step('share', 'focos_MODIS / (focos_MODIS + focos_VIIRS) × 100', { modisRaw: dash.modisRaw, viirsRaw: dash.viirsRaw, viirsPct: viirsShare }, modisShare, '%'),
    ],
    uncertainty: noInterval(data, null),
    history: { labelKey: HISTORY_KEYS.sensor, points },
    whatChanges: [{ id: 'new-data', params: { year: data.currentYear } }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sensor: true, hotspot: true }),
  })
}

// ---------------------------------------------------------------------------------------------
// 8. Climatologia
// ---------------------------------------------------------------------------------------------

/**
 * Climatologia mensal da janela de referência. Com `month` (0..11): média e faixa P05–P95 daquele mês.
 * Sem `month`: o mês de pico (maior média positiva); value.raw é null se nenhum mês tem média positiva.
 */
export function explainClimatology(data: ExplainData, month?: number): ExplainContext {
  const polygon = modeOf(data) === 'polygon'
  const counts = countsOf(data)
  const trace = climatologyTraceOf(counts, data.years, data.baseline, data.months)
  let index: number | null = null
  if (month !== undefined && Number.isInteger(month) && month >= 0 && month < 12) index = month
  else {
    for (let i = 0; i < trace.length; i++) {
      const best = index === null ? -Infinity : trace[index].mean ?? -Infinity
      const current = trace[i].mean
      if (current !== null && current > 0 && current > best) index = i
    }
  }
  const dashMonth = index === null ? null : data.dashboard.climatology[index] ?? null
  // O que a tela exibe (dashboard.climatology) é a fonte do valor; o cálculo local só fornece n e anos.
  const shown = dashMonth ?? (index === null ? null : trace[index])
  const n = index === null ? null : trace[index].n
  const years = index === null ? [] : trace[index].years
  const low = shown?.p05 ?? null
  const high = shown?.p95 ?? null
  const label = index === null ? null : data.months[index] ?? String(index)
  const observedMonth = observedRange(index === null ? [] : referenceValues(counts, data.years, data.baseline, index).values)
  const steps: ExplainStep[] = polygon
    ? [
        step('sample', 'valores do mês nos anos de referência com dado', { month: label, n, years: listOf(years), baselineFrom: data.baseline.from, baselineTo: data.baseline.to }, n),
        step('mean', 'média(amostra do mês)', { n }, shown?.mean ?? null, 'hotspots/month'),
        step('range', `P${RANGE_LOW_P * 100}–P${RANGE_HIGH_P * 100}(amostra do mês)`, { n, p05: low, p95: high, ...observedMonth }, high, 'hotspots/month'),
      ]
    : [apiStep(data, 'api-value', 'média mensal e faixa P05–P95 dos anos de referência (valores da API)', { month: label, n, p05: low, p95: high, ...observedMonth }, shown?.mean ?? null, 'hotspots/month')]
  const points: ExplainHistoryPoint[] = data.dashboard.climatology.map((item, i) => ({ x: data.months[i] ?? i, y: item.mean }))
  return assemble(data, {
    kind: 'climatology',
    labelKey: LABEL_KEYS.climatology,
    value: { raw: shown?.mean ?? null, unit: 'hotspots/month' },
    derivedBy: polygon ? 'client' : 'api',
    steps,
    uncertainty: {
      pct: data.dashboard.uncertainty,
      confidence: data.dashboard.confidence,
      sampleSize: n,
      interval: { low, high, label: low === null || high === null ? 'none' : intervalLabel(n) },
    },
    history: { labelKey: HISTORY_KEYS.monthly, points, highlightX: label ?? undefined },
    whatChanges: [{ id: 'baseline-window' }, { id: 'new-year-complete' }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sample: n, interval: low === null || high === null ? null : { n }, hotspot: true }),
    whatIf: polygon ? whatIfSpecBaseline(data) : undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// 9. Série anual
// ---------------------------------------------------------------------------------------------

/** Total anual de um ano (padrão: ano corrente) e seu desvio contra a média de referência. */
export function explainAnnual(data: ExplainData, year?: number): ExplainContext {
  const target = year ?? data.currentYear
  const counts = countsOf(data)
  const annual = annualSeries(counts, data.years)
  const point = annual.find((item) => item.year === target) ?? null
  const yearIndex = data.years.indexOf(target)
  const row = (yearIndex >= 0 ? counts[yearIndex] : undefined) ?? []
  const monthsKnown = row.filter((value) => value !== null && value !== undefined).length
  const reference = referenceYearsOf(data)
  const n = reference.years.length
  const baselineAnnual = n ? mean(reference.values) : null
  const total = point?.total ?? null
  const partial = point ? point.partial : null
  const comparable = total !== null && partial === false && baselineAnnual !== null && baselineAnnual !== 0
  const deviation = comparable ? ((total - (baselineAnnual as number)) / (baselineAnnual as number)) * 100 : null
  return assemble(data, {
    kind: 'annual',
    labelKey: LABEL_KEYS.annual,
    value: { raw: total, unit: 'hotspots' },
    derivedBy: 'client',
    steps: [
      step('sum', 'Σ_meses focos(ano, mês)', { year: target, monthsKnown, partial }, total, 'hotspots'),
      step('baseline-mean', 'média(total anual completo da referência)', { n, baselineFrom: data.baseline.from, baselineTo: data.baseline.to }, baselineAnnual, 'hotspots'),
      step('deviation', '(total − média_referência) / média_referência × 100', { total, baselineMean: baselineAnnual, partial }, deviation, '%'),
    ],
    uncertainty: noInterval(data, n),
    history: { labelKey: HISTORY_KEYS.annual, points: annualPoints(annual), highlightX: target },
    whatChanges: [{ id: 'new-data', params: { year: target } }, { id: 'baseline-window' }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sample: n, hotspot: true }),
  })
}

// ---------------------------------------------------------------------------------------------
// 10. Célula do calendário
// ---------------------------------------------------------------------------------------------

/** Uma célula ano×mês do calendário: contagem e anomalia contra a média do mesmo mês na referência. */
export function explainCalendarCell(data: ExplainData, year: number, month: number): ExplainContext {
  const polygon = modeOf(data) === 'polygon'
  const counts = countsOf(data)
  const yearIndex = data.years.indexOf(year)
  const monthOk = Number.isInteger(month) && month >= 0 && month < 12
  const valid = yearIndex >= 0 && monthOk
  const raw = valid ? counts[yearIndex]?.[month] ?? null : null
  const reference = monthOk ? referenceValues(counts, data.years, data.baseline, month) : { years: [], values: [] }
  const n = reference.values.length
  const referenceMean = n ? mean(reference.values) : null
  const anomaly = valid ? anomalyMatrix(counts, data.years, data.baseline)[yearIndex]?.[month] ?? null : null
  const low = n ? percentile(reference.values, RANGE_LOW_P) : null
  const high = n ? percentile(reference.values, RANGE_HIGH_P) : null
  const monthLabel = monthOk ? data.months[month] ?? String(month) : null

  let cellStep: ExplainStep
  if (polygon && valid) {
    const values: Record<string, ExplainScalar> = {}
    const parts = activeWeights(data).map((weight) => {
      const value = data.regions?.find((region) => region.id === weight.id)?.counts[yearIndex]?.[month] ?? null
      values[`w_${weight.id}`] = weight.weight
      values[`v_${weight.id}`] = value
      return { weight: weight.weight, value }
    })
    // Mesma regra de series.ts: null só se TODAS as regiões estão sem dado; região sem dado entre outras entra como 0.
    cellStep = step('blend', 'Σ_regiões peso × focos(região, ano, mês)', { year, month: monthLabel, ...values }, blendCell(parts), 'hotspots')
  } else {
    cellStep = step('cell', 'focos(região, ano, mês)', { year, month: monthLabel }, raw, 'hotspots')
  }
  const column: ExplainHistoryPoint[] = data.years.map((y, i) => ({ x: y, y: monthOk ? counts[i]?.[month] ?? null : null }))
  return assemble(data, {
    kind: 'calendar-cell',
    labelKey: LABEL_KEYS.calendarCell,
    value: { raw, unit: 'hotspots' },
    derivedBy: 'client',
    steps: [
      cellStep,
      step('reference', 'média(mesmo mês nos anos de referência com dado)', { n, years: listOf(reference.years), baselineFrom: data.baseline.from, baselineTo: data.baseline.to, ...observedRange(reference.values) }, referenceMean, 'hotspots'),
      step('anomaly', '(valor − média_referência) / média_referência × 100', { value: raw, referenceMean }, anomaly, '%'),
    ],
    uncertainty: {
      pct: data.dashboard.uncertainty,
      confidence: data.dashboard.confidence,
      sampleSize: n,
      interval: { low, high, label: low === null || high === null ? 'none' : intervalLabel(n) },
    },
    history: { labelKey: HISTORY_KEYS.cellYears, points: column, highlightX: year },
    whatChanges: [{ id: 'baseline-window' }, { id: 'new-data', params: { year } }, { id: 'calibration' }],
    caveats: caveatsOf({ ...caveatBase(data), sample: n, interval: low === null || high === null ? null : { n }, hotspot: true }),
    whatIf: polygon ? whatIfSpecBaseline(data) : undefined,
  })
}

// ---------------------------------------------------------------------------------------------
// 11 e 12. Calculadora de cenários
// ---------------------------------------------------------------------------------------------

function forecastOptionsOf(options: ForecastExplainOptions): ForecastOptions {
  return options.alertPercentile === undefined ? {} : { alertPercentile: options.alertPercentile }
}

function forecastBase(
  region: RegionSeries,
  forecast: Forecast,
  context: ForecastContext,
  options: ForecastExplainOptions,
  kind: ExplainKind,
  labelKey: string,
): Pick<ExplainContext, 'schema' | 'kind' | 'labelKey' | 'scope' | 'source'> {
  const sensors: string[] = []
  if (region.metrics.modisRaw > 0) sensors.push('MODIS')
  if (region.metrics.viirsRaw > 0) sensors.push('VIIRS')
  return {
    schema: 1,
    kind,
    labelKey,
    scope: options.polygon
      ? { mode: 'polygon', regionId: null, regionName: options.polygon.name, weights: options.polygon.weights }
      : { mode: 'region', regionId: forecast.regionId, regionName: forecast.regionName },
    source: sourceOf(options.meta, sensors, context.baseline),
  }
}

function forecastCaveatFlags(
  region: RegionSeries,
  forecast: Forecast,
  options: ForecastExplainOptions,
): Pick<CaveatFlags, 'mode' | 'mock' | 'calibration' | 'polygonRegions' | 'sample' | 'sampleKind'> {
  return {
    mode: options.polygon ? 'polygon' : 'region',
    mock: options.meta?.mode === 'mock',
    calibration: { factor: region.metrics.factor, uncertaintyPct: forecast.uncertaintyPct, confidence: forecast.confidence },
    polygonRegions: options.polygon?.weights.length,
    sample: forecast.sampleYears,
    sampleKind: 'projection',
  }
}

/**
 * Projeção de um ano da calculadora. `yearIndex` é o índice em forecast.years (0 = ano seguinte ao corrente);
 * é limitado ao intervalo válido. value.raw é o esperado, ou null quando a amostra é insuficiente
 * (nada é exibido como projeção). Todos os passos usam as mesmas funções de forecastRegion.
 */
export function explainForecastYear(
  region: RegionSeries,
  inputs: CalcInputs,
  context: ForecastContext,
  yearIndex: number,
  options: ForecastExplainOptions = {},
): ExplainContext {
  const safeIndex = Math.max(0, Math.round(Number.isFinite(yearIndex) ? yearIndex : 0))
  const forecast = forecastRegion(region, { ...inputs, horizonYears: Math.max(inputs.horizonYears, safeIndex + 1) }, context, forecastOptionsOf(options))
  const projection = forecast.years[Math.min(safeIndex, forecast.years.length - 1)]
  const sample = baselineSampleTrace(region, context.baseline)
  const n = sample.values.length
  const percentileUsed = options.alertPercentile ?? DEFAULT_ALERT_PERCENTILE
  const trend = region.metrics.trendPctDecade
  const factorTrace = trendFactorTrace(trend ?? 0, projection.year, context.baseline.to)
  const hits = exceedance(sample.values, projection.factor, forecast.alertThreshold)
  const empty = n === 0
  const meanShown = empty ? region.metrics.baselineMeanAnnual ?? null : forecast.baselineMean
  const expectedShown = meanShown === null ? null : meanShown * projection.factor
  const shifted = sample.values.map((value) => value * projection.factor)
  const sufficient = forecast.sufficient

  const points: ExplainHistoryPoint[] = sample.years.map((year, index) => ({ x: year, y: sample.values[index] }))
  points.push({ x: projection.year, y: sufficient ? projection.expected : null, partial: true })

  return {
    ...forecastBase(region, forecast, context, options, 'forecast-year', LABEL_KEYS.forecastYear),
    value: { raw: sufficient ? projection.expected : null, unit: 'hotspots' },
    formula: {
      derivedBy: 'client',
      steps: [
        step('sample', 'anos completos de referência', { baselineFrom: context.baseline.from, baselineTo: context.baseline.to, n, years: listOf(sample.years), excluded: listOf(sample.excluded.map((item) => `${item.year}:${item.reason}`)) }, n),
        step('mean', 'média(amostra)', { n, fallbackApiMean: empty ? region.metrics.baselineMeanAnnual : null }, meanShown, 'hotspots'),
        step(
          'factor',
          `1 + tendência/100 × (ano − âncora)/10, limitado a [${MIN_FACTOR}; ${MAX_FACTOR}]`,
          {
            trendPctDecade: trend,
            trendIsNull: trend === null,
            trendUsed: trend ?? 0,
            anchorYear: context.baseline.to,
            year: projection.year,
            decadesAhead: factorTrace.decadesAhead,
            raw: factorTrace.raw,
            clamped: factorTrace.clamped,
          },
          projection.factor,
          'x',
        ),
        step('expected', 'média × fator', { mean: meanShown, factor: projection.factor }, expectedShown, 'hotspots'),
        step('threshold', 'percentil_alerta(amostra)', { alertPercentile: percentileUsed, n }, empty ? null : forecast.alertThreshold, 'hotspots'),
        step('range', `P${RANGE_LOW_P * 100}–P${RANGE_HIGH_P * 100}(amostra × fator)`, { p05: empty ? null : projection.low, p95: empty ? null : projection.high, n: shifted.length, ...observedRange(shifted) }, empty ? null : projection.high, 'hotspots'),
        step('exceedance', '#{amostra × fator > limiar} / n', { count: empty ? null : hits.count, n: hits.n, threshold: empty ? null : forecast.alertThreshold }, empty ? null : projection.chanceAboveAlert),
      ],
    },
    uncertainty: {
      pct: forecast.uncertaintyPct,
      confidence: forecast.confidence,
      sampleSize: n,
      interval: sufficient ? { low: projection.low, high: projection.high, label: intervalLabel(n) } : { low: null, high: null, label: 'none' },
    },
    history: { labelKey: HISTORY_KEYS.projection, points, highlightX: projection.year },
    whatChanges: [
      { id: 'baseline-window' },
      { id: 'trend-override' },
      { id: 'alert-percentile' },
      { id: 'horizon' },
      { id: 'new-year-complete' },
      { id: 'calibration' },
    ],
    caveats: caveatsOf({
      ...forecastCaveatFlags(region, forecast, options),
      interval: sufficient ? { n } : null,
      exceedance: { alertPercentile: percentileUsed },
      trendAnchor: { anchorYear: context.baseline.to, apiWindow: region.metrics.trendWindow || null },
      hotspot: true,
      costs: true,
    }),
    whatIf: {
      controls: ['baseline', 'trend', 'alertPercentile', 'horizonYear'],
      current: {
        baselineFrom: context.baseline.from,
        baselineTo: context.baseline.to,
        alertPercentile: percentileUsed,
        trendPctDecade: trend,
        horizonYear: projection.year,
      },
    },
  }
}

/** Plano de postos (cobertura × carga) do cenário. value.raw é o nº recomendado, ou null com amostra insuficiente. */
export function explainPostPlan(
  region: RegionSeries,
  inputs: CalcInputs,
  context: ForecastContext,
  options: ForecastExplainOptions = {},
): ExplainContext {
  const forecast = forecastRegion(region, inputs, context, forecastOptionsOf(options))
  const posts = forecast.posts
  const areaKm2 = ringAreaKm2(region.ring)
  const factors = forecast.years.map((item) => item.factor)
  const peakExpected = peakMonthlyExpectedOf(region, factors)
  const existing = Math.max(0, Math.round(inputs.existingPosts))
  const sufficient = forecast.sufficient
  const radius = Math.max(1, inputs.coverageRadiusKm)
  const perPost = Math.max(1, inputs.focusesPerPostMonth)
  const steps: ExplainStep[] = [
    step('area', 'área do anel lon/lat em esfera', { vertices: region.ring.length }, areaKm2, 'km2'),
    step('coverage', '⌈área / (π × raio²)⌉', { areaKm2, radiusKm: radius }, posts.coverageMinPosts, 'posts'),
    step('workload', '⌈pico mensal esperado / focos por posto-mês⌉', { peakMonthlyExpected: peakExpected, focusesPerPostMonth: perPost, horizonYears: forecast.horizonYears }, posts.workloadPosts, 'posts'),
    step('recommended', 'máx(1, cobertura, carga)', { coverage: posts.coverageMinPosts, workload: posts.workloadPosts }, posts.recommendedPosts, 'posts'),
    step('response', 'distância = 0,5 × √(área / postos) × fator_rota; tempo = distância / velocidade × 60', { areaKm2, posts: posts.recommendedPosts, travelSpeedKmh: inputs.travelSpeedKmh, roadFactor: ROAD_FACTOR }, responseMinutes(areaKm2, posts.recommendedPosts, inputs.travelSpeedKmh), 'min'),
  ]
  // Sem postos existentes não há tempo atual: fica null, nunca 0.
  steps.push(
    step('current-response', 'mesma fórmula com os postos existentes', { existingPosts: existing, areaKm2, travelSpeedKmh: inputs.travelSpeedKmh }, posts.currentMinutes, 'min'),
    step('missing', 'máx(0, recomendados − existentes)', { recommended: posts.recommendedPosts, existing }, posts.missingPosts, 'posts'),
  )
  return {
    ...forecastBase(region, forecast, context, options, 'post-plan', LABEL_KEYS.postPlan),
    value: { raw: sufficient ? posts.recommendedPosts : null, unit: 'posts' },
    formula: { derivedBy: 'client', steps },
    uncertainty: {
      pct: forecast.uncertaintyPct,
      confidence: forecast.confidence,
      sampleSize: forecast.sampleYears,
      interval: { low: null, high: null, label: 'none' },
    },
    history: { labelKey: HISTORY_KEYS.none, points: [] },
    whatChanges: [{ id: 'inputs' }, { id: 'baseline-window' }, { id: 'trend-override' }, { id: 'calibration' }],
    caveats: caveatsOf({
      ...forecastCaveatFlags(region, forecast, options),
      trendAnchor: { anchorYear: context.baseline.to, apiWindow: region.metrics.trendWindow || null },
      hotspot: true,
      costs: true,
    }),
  }
}
