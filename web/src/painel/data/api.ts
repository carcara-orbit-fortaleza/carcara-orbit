import type { Hotspot, RegionSeries, Workspace } from '../types'

// Cliente do painel. Fala com a API real (NestJS, PR #1 da api), que usa nomes snake_case
// e anos inteiros. Converte para o formato que o painel usa.

type Matrix = (number | null)[][]

// Em desenvolvimento a API roda na porta 3000. Em produção, defina VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type ApiRegion = {
  id: string
  name: string
  biome: string
  area_km2: number
  center: [number, number]
  color: string
  polygon: [number, number][]
}

type ApiMetrics = {
  biome?: string
  current_year_total?: number | null
  current_year_anomaly_pct?: number | null
  peak_year?: number | null
  peak_year_total?: number | null
  trend_pct_decade?: number | null
  trend_window?: string | null
  baseline_mean_annual?: number | null
  sensor_mix?: { modis_pct?: number; viirs_pct?: number; modis_raw?: number; viirs_raw?: number }
  harmonization?: { factor_by_region?: number; uncertainty_pct?: number; confidence?: string }
}

type ApiCalendar = {
  mode?: string
  region: { id: string; name: string }
  years: number[]
  months: string[]
  counts: Matrix
  raw_modis: Matrix
  raw_viirs: Matrix
  insights: string[]
  series: {
    annual: { year: number; total: number | null; partial: boolean; anomaly_pct: number | null }[]
  }
  metrics: ApiMetrics
}

type ApiMeta = { disclaimer?: string; period?: { start?: string; end?: string } }

type ApiHotspotFile = {
  features: {
    properties?: {
      id?: string
      date?: string
      region_id?: string
      sensor?: string
      platform?: string
      frp_mw?: number | null
      confidence?: number | null
    }
    geometry?: { coordinates?: [number, number] }
  }[]
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    // Cookies de sessão: a API usa cookie httpOnly, então a requisição precisa levá-lo.
    response = await fetch(`${API_BASE}${path.replace(/^\/api/, '')}`, { credentials: 'include' })
  } catch {
    throw new ApiError(0, 'Sem conexão com a API.')
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string }
      detail = body.message ? ` ${body.message}` : ''
    } catch {
      detail = ''
    }
    throw new ApiError(response.status, `Falha em ${path} (${response.status}).${detail}`)
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

/** Média e faixa (p05–p95) de cada mês, usando só os anos com dado. */
function climatologyFrom(counts: Matrix, months: string[]) {
  return months.map((label, month) => {
    const values = counts
      .map((row) => row[month])
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b)
    const mean = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
    return { label, mean, p05: percentile(values, 0.05), p95: percentile(values, 0.95) }
  })
}

function metricsFrom(api: ApiMetrics): RegionSeries['metrics'] {
  return {
    biome: api.biome ?? '',
    currentYearTotal: api.current_year_total ?? 0,
    currentYearAnomaly: api.current_year_anomaly_pct ?? 0,
    peakYear: api.peak_year ?? 0,
    peakYearTotal: api.peak_year_total ?? 0,
    trendPctDecade: api.trend_pct_decade ?? 0,
    trendWindow: api.trend_window ?? '',
    modisPct: api.sensor_mix?.modis_pct ?? 0,
    viirsPct: api.sensor_mix?.viirs_pct ?? 0,
    modisRaw: api.sensor_mix?.modis_raw ?? 0,
    viirsRaw: api.sensor_mix?.viirs_raw ?? 0,
    factor: api.harmonization?.factor_by_region ?? 1,
    uncertaintyPct: api.harmonization?.uncertainty_pct ?? 0,
    confidence: api.harmonization?.confidence ?? '',
    baselineMeanAnnual: api.baseline_mean_annual ?? 0,
  }
}

function regionSeriesFrom(region: ApiRegion, calendar: ApiCalendar): RegionSeries {
  const climatology = climatologyFrom(calendar.counts, calendar.months)
  const peak = climatology.reduce((best, month) => (month.mean > best.mean ? month : best), climatology[0])
  return {
    id: region.id,
    name: region.name,
    color: region.color,
    ring: region.polygon,
    counts: calendar.counts,
    rawModis: calendar.raw_modis,
    rawViirs: calendar.raw_viirs,
    insights: calendar.insights,
    metrics: metricsFrom(calendar.metrics),
    climatology,
    annual: calendar.series.annual.map((point) => ({
      year: point.year,
      total: point.total ?? 0,
      partial: Boolean(point.partial),
      anomaly: point.anomaly_pct ?? 0,
    })),
    peakMonthLabel: peak && peak.mean > 0 ? peak.label : '—',
  }
}

export async function loadWorkspace(): Promise<Workspace> {
  await getJson<{ status: string }>('/health')
  const meta = await getJson<ApiMeta>('/meta')
  const regions = await getJson<ApiRegion[]>('/regions')
  const calendars = await Promise.all(
    regions.map((region) => getJson<ApiCalendar>(`/calendar?region=${encodeURIComponent(region.id)}&from=2000&to=2026`)),
  )
  const first = calendars[0]
  if (!first) throw new ApiError(404, 'A API não devolveu calendários.')

  return {
    years: first.years,
    months: first.months,
    disclaimer:
      meta.disclaimer ??
      'Série harmonizada em construção. Os números desta tela não devem ser usados para decisão operacional.',
    hotspots: [],
    regions: regions.map((region, index) => regionSeriesFrom(region, calendars[index])),
  }
}

export async function loadHotspots(): Promise<Hotspot[]> {
  const points = await getJson<ApiHotspotFile>('/hotspots?from=2024&to=2026')
  const hotspots: Hotspot[] = []
  for (const feature of points.features) {
    const coords = feature.geometry?.coordinates
    if (!coords) continue
    const [lon, lat] = coords
    hotspots.push({
      id: feature.properties?.id ?? `${lon},${lat}`,
      date: feature.properties?.date ?? '',
      regionId: feature.properties?.region_id ?? '',
      sensor: feature.properties?.sensor ?? '',
      platform: feature.properties?.platform ?? '',
      frp: feature.properties?.frp_mw ?? 0,
      confidence: feature.properties?.confidence ?? 0,
      lon,
      lat,
    })
  }
  return hotspots
}
