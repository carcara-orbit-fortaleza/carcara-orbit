import type { Vars } from '../../i18n/I18nContext'
import type { MessageKey } from '../../i18n/messages'
import type { DatasetMeta, Hotspot, RegionMetrics, RegionSeries, Workspace } from '../types'
import type { ExplainAskRequest, ExplainAskResponse } from '../explain/types'

// Cliente do painel para a trilha global da API (`/api/global/*`).
// Converte o contrato snake_case da grade global para o formato do painel.

type Matrix = (number | null)[][]

// Em desenvolvimento a API roda na porta 3000. Em produção, defina VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

// Células exibidas no painel. O endpoint devolve as mais ativas primeiro.
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

type ApiGlobalRegion = {
  id: string
  name: string
  biome?: string
  color?: string
  polygon?: [number, number][]
  center?: [number, number]
  hotspots?: number
  first_year?: number
  last_year?: number
}

type ApiGlobalRegions = {
  scope?: string
  gridDegrees?: number | null
  total?: number
  returned?: number
  regions: ApiGlobalRegion[]
}

type ApiGlobalCalendar = {
  mode?: string
  region: ApiGlobalRegion | null
  months: string[]
  years: number[]
  counts: Matrix
  raw_modis: Matrix
  raw_viirs: Matrix
  series: {
    annual: {
      year: number
      total: number | null
      partial: boolean
      anomaly_pct: number | null
    }[]
  }
  metrics: {
    current_year?: number
    current_year_total?: number | null
    current_year_anomaly_pct?: number | null
    peak_year?: number | null
    peak_year_total?: number | null
    baseline_mean_annual?: number | null
    modis_total?: number | null
    viirs_total?: number | null
  }
  meta?: {
    disclaimer?: string
    method_version?: string
    baseline_years?: [number, number]
    grid_degrees?: number | null
  }
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

function regionSeriesFrom(region: ApiGlobalRegion, calendar: ApiGlobalCalendar, meta: DatasetMeta): RegionSeries {
  const annual = calendar.series.annual.map((point) => ({
    year: point.year,
    total: finite(point.total),
    partial: Boolean(point.partial),
    anomaly: finite(point.anomaly_pct),
  }))
  const climatology = climatologyFrom(calendar.counts, calendar.months, calendar.years, meta.baselineFrom, meta.baselineTo)
  const peak = climatology.reduce<(typeof climatology)[number] | null>(
    (best, month) => (month.mean !== null && (best === null || month.mean > (best.mean ?? -Infinity)) ? month : best),
    null,
  )
  const modisRaw = calendar.metrics.modis_total ?? 0
  const viirsRaw = calendar.metrics.viirs_total ?? 0
  const rawTotal = modisRaw + viirsRaw

  const metrics: RegionMetrics = {
    biome: region.biome ?? 'Grade global',
    currentYearTotal: finite(calendar.metrics.current_year_total),
    currentYearAnomaly: finite(calendar.metrics.current_year_anomaly_pct),
    peakYear: finite(calendar.metrics.peak_year),
    peakYearTotal: finite(calendar.metrics.peak_year_total),
    trendPctDecade: trendPctDecade(annual),
    trendWindow: `${meta.baselineFrom}–${meta.baselineTo}`,
    modisPct: rawTotal > 0 ? (modisRaw / rawTotal) * 100 : 0,
    viirsPct: rawTotal > 0 ? (viirsRaw / rawTotal) * 100 : 0,
    modisRaw,
    viirsRaw,
    // A API global aplica o fator por célula/mês ao montar `counts`.
    factor: 1,
    uncertaintyPct: null,
    confidence: 'global',
    baselineMeanAnnual: finite(calendar.metrics.baseline_mean_annual),
  }

  return {
    id: region.id,
    name: region.name,
    color: region.color ?? '#4E79A7',
    ring: region.polygon ?? [],
    counts: calendar.counts,
    rawModis: calendar.raw_modis,
    rawViirs: calendar.raw_viirs,
    // Sem texto gerado no cliente: o painel monta as leituras na língua atual.
    insights: [],
    metrics,
    climatology,
    annual,
    peakMonthLabel: peak && peak.mean !== null && peak.mean > 0 ? peak.label : '—',
  }
}

/** Metadados do dataset global, derivados da calibração servida junto com o calendário. */
function globalDatasetMeta(calendar: ApiGlobalCalendar): DatasetMeta {
  const baseline = calendar.meta?.baseline_years ?? [2003, 2025]
  const years = calendar.years ?? []
  return {
    mode: 'real',
    methodVersion: calendar.meta?.method_version ?? 'h1.0',
    datasetVersion: calendar.meta?.method_version ?? '',
    currentYear: years.length ? Math.max(...years) : new Date().getFullYear(),
    baselineFrom: baseline[0],
    baselineTo: baseline[1],
    calibrationWindow: `${baseline[0]}–${baseline[1]}`,
    periodStart: null,
    periodEnd: null,
    lastCompleteYear: null,
    warnings: [],
  }
}

export async function loadWorkspace(): Promise<Workspace> {
  await getJson<{ status: string }>('/health')
  const response = await getJson<ApiGlobalRegions>(`/global/regions?limit=${GLOBAL_REGION_LIMIT}`)
  const regions = response.regions ?? []
  if (regions.length === 0) throw new ApiError(404, 'panelErrNoGrid')

  // Se a ingestão estiver escrevendo no SQLite, alguma célula pode falhar.
  const to = new Date().getFullYear()
  const calendars = await Promise.all(
    regions.map((region) =>
      getJson<ApiGlobalCalendar>(`/global/calendar?region=${encodeURIComponent(region.id)}&from=2000&to=${to}`).catch(
        () => null,
      ),
    ),
  )
  const pairs = regions
    .map((region, index) => ({ region, calendar: calendars[index] }))
    .filter((pair): pair is { region: ApiGlobalRegion; calendar: ApiGlobalCalendar } => pair.calendar !== null)
  const first = pairs[0]
  if (!first) throw new ApiError(404, 'panelErrNoCalendars')

  const meta = globalDatasetMeta(first.calendar)
  return {
    years: first.calendar.years,
    months: first.calendar.months,
    // Texto vindo da API (vazio se ausente). A tela cai na versão traduzida em panelDisclaimerFallback.
    disclaimer: first.calendar.meta?.disclaimer ?? '',
    hotspots: [],
    regions: pairs.map((pair) => regionSeriesFrom(pair.region, pair.calendar, meta)),
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
