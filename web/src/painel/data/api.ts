import type { Hotspot, RegionMetrics, RegionSeries, Workspace } from '../types'

// Cliente do painel para a trilha global da API (`/api/global/*`).
// Converte o contrato snake_case da grade global para o formato do painel.

type Matrix = (number | null)[][]

// Em desenvolvimento a API roda na porta 3000. Em produção, defina VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

// Células exibidas no painel. O endpoint devolve as mais ativas primeiro.
const GLOBAL_REGION_LIMIT = 24

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
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
  features: {
    properties?: {
      id?: string
      date?: string
      region_id?: string | null
      sensor?: string
      platform?: string | null
      frp_mw?: number | null
      confidence?: number | null
    }
    geometry?: { coordinates?: [number, number] }
  }[]
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
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

function trendPerDecade(points: { year: number; total: number }[]): number {
  if (points.length < 2) return 0
  const xs = points.map((point) => point.year)
  const ys = points.map((point) => point.total)
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  if (meanY === 0) return 0
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  if (denominator === 0) return 0
  return ((numerator / denominator) * 10 / meanY) * 100
}

function formatShare(value: number): string {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

function regionSeriesFrom(region: ApiGlobalRegion, calendar: ApiGlobalCalendar): RegionSeries {
  const annual = calendar.series.annual.map((point) => ({
    year: point.year,
    total: point.total ?? 0,
    partial: point.partial,
    anomaly: point.anomaly_pct ?? 0,
  }))
  const latest =
    [...annual].reverse().find((point) => point.total > 0) ??
    annual[annual.length - 1]
  const baseline = calendar.meta?.baseline_years ?? [2003, 2025]
  const modisRaw = calendar.metrics.modis_total ?? 0
  const viirsRaw = calendar.metrics.viirs_total ?? 0
  const rawTotal = modisRaw + viirsRaw
  const modisPct = rawTotal > 0 ? (modisRaw / rawTotal) * 100 : 0
  const viirsPct = rawTotal > 0 ? (viirsRaw / rawTotal) * 100 : 0
  const withData = annual.filter((point) => point.total > 0)
  const peak =
    withData.reduce<{ year: number; total: number } | null>(
      (best, point) => (best === null || point.total > best.total ? point : best),
      null,
    )
  const peakYear = calendar.metrics.peak_year ?? peak?.year ?? 0
  const peakTotal = calendar.metrics.peak_year_total ?? peak?.total ?? 0

  const metrics: RegionMetrics = {
    biome: region.biome ?? 'Grade global',
    currentYearTotal: latest?.total ?? 0,
    currentYearAnomaly: latest?.anomaly ?? 0,
    peakYear,
    peakYearTotal: peakTotal,
    trendPctDecade: trendPerDecade(annual),
    trendWindow: `${baseline[0]}–${baseline[1]}`,
    modisPct,
    viirsPct,
    modisRaw,
    viirsRaw,
    // A API global aplica o fator por célula/mês ao montar `counts`.
    factor: 1,
    uncertaintyPct: 0,
    confidence: 'global',
    baselineMeanAnnual: calendar.metrics.baseline_mean_annual ?? 0,
  }

  const climatology = climatologyFrom(calendar.counts, calendar.months)
  const peakMonth = climatology.reduce(
    (best, month) => (month.mean > best.mean ? month : best),
    climatology[0],
  )

  return {
    id: region.id,
    name: region.name,
    color: region.color ?? '#4E79A7',
    ring: region.polygon ?? [],
    counts: calendar.counts,
    rawModis: calendar.raw_modis,
    rawViirs: calendar.raw_viirs,
    insights: [
      `Célula global ${region.name} (grade de ${calendar.meta?.grid_degrees ?? '—'}°).`,
      peakYear > 0
        ? `Pico histórico em ${peakYear}: ${peakTotal.toLocaleString('pt-BR')} focos.`
        : 'Sem pico histórico disponível.',
      `MODIS ${formatShare(modisPct)} · VIIRS ${formatShare(viirsPct)} dos focos brutos.`,
    ],
    metrics,
    climatology,
    annual,
    peakMonthLabel: peakMonth && peakMonth.mean > 0 ? peakMonth.label : '—',
  }
}

export async function loadWorkspace(): Promise<Workspace> {
  await getJson<{ status: string }>('/health')
  const response = await getJson<ApiGlobalRegions>(
    `/global/regions?limit=${GLOBAL_REGION_LIMIT}`,
  )
  const regions = response.regions ?? []
  if (regions.length === 0) {
    throw new ApiError(
      404,
      'A grade global ainda não tem dados. A ingestão global está em andamento.',
    )
  }

  // Se a ingestão estiver escrevendo no SQLite, alguma célula pode falhar.
  const calendars = await Promise.all(
    regions.map((region) =>
      getJson<ApiGlobalCalendar>(
        `/global/calendar?region=${encodeURIComponent(region.id)}&from=2000&to=2026`,
      ).catch(() => null),
    ),
  )
  const pairs = regions
    .map((region, index) => ({ region, calendar: calendars[index] }))
    .filter((pair): pair is { region: ApiGlobalRegion; calendar: ApiGlobalCalendar } =>
      pair.calendar !== null,
    )
  const first = pairs[0]
  if (!first) throw new ApiError(404, 'A API não devolveu calendários globais.')

  return {
    years: first.calendar.years,
    months: first.calendar.months,
    disclaimer:
      first.calendar.meta?.disclaimer ??
      'Contagens globais derivadas de focos ativos NASA FIRMS/Earthdata. Uso informativo; não substitui validação oficial.',
    hotspots: [],
    regions: pairs.map((pair) => regionSeriesFrom(pair.region, pair.calendar)),
  }
}

export async function loadHotspots(): Promise<Hotspot[]> {
  const points = await getJson<ApiGlobalHotspotFile>('/global/hotspots?from=2024&to=2026')
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
