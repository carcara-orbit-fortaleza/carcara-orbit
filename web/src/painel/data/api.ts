import type { Vars } from '../../i18n/I18nContext'
import type { MessageKey } from '../../i18n/messages'
import type { DatasetMeta, Hotspot, RegionMetrics, RegionSeries, Workspace } from '../types'
import type { ExplainAskRequest, ExplainAskResponse } from '../explain/types'

// Cliente do painel para a camada agregada global (`/api/global/aggregates`).
// A API devolve, para cada célula, as matrizes anuais/mensais harmonizadas,
// MODIS e VIIRS, além dos fatores de calibração. O painel carrega as células
// mais ativas em uma requisição e calcula o calendário de qualquer AOI.

type Matrix = (number | null)[][]

// Em desenvolvimento a API roda na porta 3000. Em produção, defina VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

// Células exibidas no painel. A API devolve as mais ativas primeiro.
const GLOBAL_REGION_LIMIT = 24

/** Erro da API. Guarda uma chave de tradução, não texto pronto: a tela traduz no idioma atual. */
export class ApiError extends Error {
  status: number
  key: MessageKey
  vars?: Vars
  constructor(status: number, key: MessageKey, vars?: Vars) {
    super(key)
    this.status = status
    this.key = key
    this.vars = vars
  }
}

type ApiAggregateCell = {
  id: string
  name: string
  short?: string | null
  biome?: string | null
  scope?: string | null
  areaKm2?: number | null
  center?: [number, number] | null
  color?: string | null
  polygon?: [number, number][] | null
  bounds?: [number, number, number, number] | null
  hotspots: number
  firstYear?: number | null
  lastYear?: number | null
  counts: Matrix
  modis: Matrix
  viirs: Matrix
  factors?: number[]
  calibration?: { factor: number; confidence: string }[]
}

type ApiAggregates = {
  scope?: string
  gridDegrees?: number
  years: number[]
  months: string[]
  methodVersion?: string
  datasetVersion?: string
  calibrationWindow?: string | null
  baselineFrom?: number
  baselineTo?: number
  currentYear?: number
  lastCompleteYear?: number | null
  warnings?: string[]
  disclaimer?: string
  source?: string
  cells: ApiAggregateCell[]
}

type ApiGlobalHotspotFile = {
  mode?: string
  total?: number
  returned?: number
  features: {
    properties?: {
      id?: string
      date?: string
      ts_utc?: string | null
      region_id?: string | null
      sensor?: string
      platform?: string | null
      frp_mw?: number | null
      confidence?: number | null
    }
    geometry?: { coordinates?: [number, number] }
  }[]
}

/** Nível de confiança vindo da API, normalizado para a chave interna. A tradução fica na tela. */
export function confidenceLevel(value: string | null | undefined): string {
  if (!value) return ''
  const key = value.toLowerCase()
  if (key === 'low' || key === 'baixa') return 'low'
  if (key === 'medium' || key === 'media' || key === 'média') return 'medium'
  if (key === 'high' || key === 'alta') return 'high'
  return value
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    // Cookies de sessão: a API usa cookie httpOnly, então a requisição precisa levá-lo.
    response = await fetch(`${API_BASE}${path.replace(/^\/api/, '')}`, { credentials: 'include' })
  } catch {
    throw new ApiError(0, 'panelErrNetwork')
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string }
      detail = body.message ?? ''
    } catch {
      detail = ''
    }
    throw new ApiError(response.status, 'panelErrHttp', { path, status: response.status, detail })
  }
  return response.json() as Promise<T>
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

/**
 * Média e faixa (p05–p95) de cada mês, usando só os anos de referência com dado.
 * O ano corrente fica de fora: a climatologia é a régua, não o que está sendo medido.
 */
function climatologyFrom(counts: Matrix, months: string[], years: number[], baselineFrom: number, baselineTo: number) {
  return months.map((label, month) => {
    const values = counts
      .filter((_, yearIndex) => years[yearIndex] >= baselineFrom && years[yearIndex] <= baselineTo)
      .map((row) => row[month])
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b)
    if (values.length === 0) return { label, mean: null, p05: null, p95: null }
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length
    return { label, mean, p05: percentile(values, 0.05), p95: percentile(values, 0.95) }
  })
}

/** Tendência linear em % por década. null quando há menos de dois anos com dado. */
function trendPctDecade(points: { year: number; total: number | null }[]): number | null {
  const valid = points.filter((point): point is { year: number; total: number } => point.total !== null)
  if (valid.length < 2) return null
  const meanX = valid.reduce((sum, point) => sum + point.year, 0) / valid.length
  const meanY = valid.reduce((sum, point) => sum + point.total, 0) / valid.length
  if (meanY === 0) return null
  let numerator = 0
  let denominator = 0
  for (const point of valid) {
    numerator += (point.year - meanX) * (point.total - meanY)
    denominator += (point.year - meanX) ** 2
  }
  if (denominator === 0) return null
  return ((numerator / denominator) * 10 / meanY) * 100
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sumMatrix(matrix: Matrix): number {
  return matrix.reduce(
    (sum, row) => sum + row.reduce<number>((rowSum, value) => rowSum + (value ?? 0), 0),
    0,
  )
}

function regionSeriesFrom(
  cell: ApiAggregateCell,
  years: number[],
  months: string[],
  meta: DatasetMeta,
): RegionSeries {
  const counts = cell.counts
  const rawModis = cell.modis
  const rawViirs = cell.viirs

  const annual = years.map((year, index) => {
    const row = counts[index] ?? []
    const known = row.filter((value): value is number => typeof value === 'number')
    const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null
    return {
      year,
      total,
      partial: known.length > 0 && known.length < 12,
      anomaly: null as number | null,
    }
  })

  const baselineTotals = annual
    .filter(
      (point) =>
        point.year >= meta.baselineFrom &&
        point.year <= meta.baselineTo &&
        point.total !== null &&
        !point.partial,
    )
    .map((point) => point.total as number)
  const baselineMean = mean(baselineTotals)

  for (const point of annual) {
    point.anomaly =
      point.total !== null && baselineMean !== null && baselineMean > 0
        ? ((point.total - baselineMean) / baselineMean) * 100
        : null
  }

  const current = annual.find((point) => point.year === meta.currentYear) ?? null
  const withData = annual.filter(
    (point): point is { year: number; total: number; partial: boolean; anomaly: number | null } =>
      point.total !== null,
  )
  const peak = withData.reduce<{ year: number; total: number } | null>(
    (best, point) => (best === null || point.total > best.total ? point : best),
    null,
  )

  const modisRaw = sumMatrix(rawModis)
  const viirsRaw = sumMatrix(rawViirs)
  const rawTotal = modisRaw + viirsRaw

  const metrics: RegionMetrics = {
    biome: cell.biome ?? 'Grade global',
    currentYearTotal: current?.total ?? null,
    currentYearAnomaly: current?.anomaly ?? null,
    peakYear: peak?.year ?? null,
    peakYearTotal: peak?.total ?? null,
    trendPctDecade: trendPctDecade(annual),
    trendWindow: `${meta.baselineFrom}–${meta.baselineTo}`,
    modisPct: rawTotal > 0 ? (modisRaw / rawTotal) * 100 : 0,
    viirsPct: rawTotal > 0 ? (viirsRaw / rawTotal) * 100 : 0,
    modisRaw,
    viirsRaw,
    // A API aplica o fator por célula/mês ao montar as contagens harmonizadas.
    factor: 1,
    uncertaintyPct: null,
    confidence: 'global',
    baselineMeanAnnual: baselineMean,
  }

  const climatology = climatologyFrom(
    counts,
    months,
    years,
    meta.baselineFrom,
    meta.baselineTo,
  )
  const peakMonth = climatology.reduce<(typeof climatology)[number] | null>(
    (best, month) =>
      month.mean !== null && (best === null || month.mean > (best.mean ?? -Infinity))
        ? month
        : best,
    null,
  )

  return {
    id: cell.id,
    name: cell.name,
    color: cell.color ?? '#4E79A7',
    ring: cell.polygon ?? [],
    counts,
    rawModis,
    rawViirs,
    // Sem texto gerado no cliente: o painel monta as leituras na língua atual.
    insights: [],
    metrics,
    climatology,
    annual,
    peakMonthLabel: peakMonth && peakMonth.mean !== null && peakMonth.mean > 0 ? peakMonth.label : '—',
  }
}

/** Metadados do dataset global, derivados do agregado servido pela API. */
function aggregateMeta(aggregate: ApiAggregates): DatasetMeta {
  const years = aggregate.years ?? []
  const currentYear =
    typeof aggregate.currentYear === 'number'
      ? aggregate.currentYear
      : years.length
        ? Math.max(...years)
        : new Date().getFullYear()
  const lastCompleteYear =
    aggregate.lastCompleteYear ?? (years.length ? Math.max(...years) : null)
  return {
    mode: 'real',
    methodVersion: aggregate.methodVersion ?? 'h1.0',
    datasetVersion: aggregate.datasetVersion ?? aggregate.methodVersion ?? '',
    currentYear,
    baselineFrom: aggregate.baselineFrom ?? 2003,
    baselineTo: aggregate.baselineTo ?? 2025,
    calibrationWindow: aggregate.calibrationWindow ?? '',
    periodStart: years.length ? `${years[0]}-01-01` : null,
    periodEnd: lastCompleteYear !== null ? `${lastCompleteYear}-12-31` : null,
    lastCompleteYear,
    warnings: aggregate.warnings ?? [],
  }
}

export async function loadWorkspace(): Promise<Workspace> {
  await getJson<{ status: string }>('/health')
  const aggregate = await getJson<ApiAggregates>('/global/aggregates')
  const cells = aggregate.cells ?? []
  if (cells.length === 0) throw new ApiError(404, 'panelErrNoGrid')

  const years = aggregate.years ?? []
  const months = aggregate.months ?? []
  if (years.length === 0 || months.length === 0) throw new ApiError(404, 'panelErrNoCalendars')

  const meta = aggregateMeta(aggregate)
  // O painel/navegação usa as células mais ativas; a API mantém todas as
  // células no agregado para consultas por AOI/exportação.
  const regions = cells
    .slice(0, GLOBAL_REGION_LIMIT)
    .map((cell) => regionSeriesFrom(cell, years, months, meta))

  return {
    years,
    months,
    disclaimer: aggregate.disclaimer ?? '',
    hotspots: [],
    regions,
    meta,
  }
}

/** Janela de focos do mapa: o ano corrente e os dois anteriores. */
export function hotspotWindow(currentYear: number): { from: number; to: number } {
  return { from: currentYear - 2, to: currentYear }
}

/** Teto de focos pedido à API (o padrão dela é 5.000, os mais novos primeiro). */
export const HOTSPOT_LIMIT = 20_000

export type HotspotFeed = {
  hotspots: Hotspot[]
  /** Quantos focos casam com o filtro na API (ou o devolvido, se ela não informar). */
  total: number
  /** A API cortou a lista (returned < total): a janela começa no corte, não no início do dado. */
  truncated: boolean
  /** Instante (ms) da detecção mais recente; null sem focos com data. Fim natural da janela. */
  latestMs: number | null
}

export async function loadHotspotFeed(currentYear: number): Promise<HotspotFeed> {
  const range = hotspotWindow(currentYear)
  const points = await getJson<ApiGlobalHotspotFile>(
    `/global/hotspots?from=${range.from}&to=${range.to}&limit=${HOTSPOT_LIMIT}`,
  )
  const hotspots: Hotspot[] = []
  let latestMs: number | null = null
  for (const feature of points.features) {
    const coords = feature.geometry?.coordinates
    if (!coords) continue
    const [lon, lat] = coords
    const date = feature.properties?.date ?? ''
    const ts = typeof feature.properties?.ts_utc === 'string' ? feature.properties.ts_utc : null
    const at = ts !== null ? Date.parse(ts) : Date.parse(date.slice(0, 10))
    if (Number.isFinite(at) && (latestMs === null || at > latestMs)) latestMs = at
    hotspots.push({
      id: feature.properties?.id ?? `${lon},${lat}`,
      date,
      ts,
      regionId: feature.properties?.region_id ?? '',
      sensor: feature.properties?.sensor ?? '',
      platform: feature.properties?.platform ?? '',
      frp: finite(feature.properties?.frp_mw),
      confidence: finite(feature.properties?.confidence),
      lon,
      lat,
    })
  }
  const returned = typeof points.returned === 'number' ? points.returned : points.features.length
  const total = typeof points.total === 'number' ? points.total : returned
  return { hotspots, total, truncated: returned < total, latestMs }
}

export async function loadHotspots(currentYear: number): Promise<Hotspot[]> {
  return (await loadHotspotFeed(currentYear)).hotspots
}

/** Falha do POST /explain. `code` segue ExplainAskError.code, mais 'network' (sem resposta) e 'unknown'. */
export class ExplainAskFailure extends Error {
  statusCode: number
  code: string
  constructor(statusCode: number, code: string, message = '') {
    super(message || code)
    this.statusCode = statusCode
    this.code = code
  }
}

const KNOWN_ASK_CODES = ['explain_disabled', 'rate_limited', 'budget_exhausted', 'invalid_request', 'upstream_error']

function isAskResponse(value: unknown): value is ExplainAskResponse {
  if (typeof value !== 'object' || value === null) return false
  const body = value as Partial<ExplainAskResponse>
  return (
    typeof body.answer === 'string' &&
    Array.isArray(body.citations) &&
    typeof body.insufficient === 'boolean' &&
    (body.confidence === 'low' || body.confidence === 'medium' || body.confidence === 'high')
  )
}

/** Nível 3: pergunta sobre um dado já explicado. A resposta é texto simples; quem chama nunca deve renderizá-la como HTML. */
export async function askExplain(request: ExplainAskRequest, signal?: AbortSignal): Promise<ExplainAskResponse> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/explain`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
    throw new ExplainAskFailure(0, 'network')
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; message?: unknown }
    const code = typeof error.code === 'string' && KNOWN_ASK_CODES.includes(error.code) ? error.code : null
    // 503/429 sem corpo reconhecível ainda têm significado próprio; 404 é uma API sem a rota (versão antiga): recurso indisponível.
    const fallback =
      response.status === 503 || response.status === 404 ? 'explain_disabled' : response.status === 429 ? 'rate_limited' : 'unknown'
    throw new ExplainAskFailure(response.status, code ?? fallback, typeof error.message === 'string' ? error.message : '')
  }
  if (!isAskResponse(body)) throw new ExplainAskFailure(response.status, 'unknown', 'malformed response')
  return body
}
