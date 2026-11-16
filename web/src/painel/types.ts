export type LonLat = [number, number]

export type Hotspot = {
  id: string
  date: string
  /** Instante da detecção (ISO UTC), quando a API manda; mede a janela com precisão de hora. */
  ts?: string | null
  regionId: string
  sensor: string
  platform: string
  frp: number | null
  confidence: number | null
  lon: number
  lat: number
}

// Campos numéricos são null quando a API não tem dado suficiente para calculá-los.
// Nunca converter null em 0: zero é uma medição, null é ausência de medição.
export type RegionMetrics = {
  biome: string
  currentYearTotal: number | null
  currentYearAnomaly: number | null
  peakYear: number | null
  peakYearTotal: number | null
  trendPctDecade: number | null
  trendWindow: string
  modisPct: number
  viirsPct: number
  modisRaw: number
  viirsRaw: number
  factor: number
  uncertaintyPct: number | null
  confidence: string
  baselineMeanAnnual: number | null
}

/** Estatística mensal sobre os anos de referência. null quando não há ano de referência com dado. */
export type ClimatologyMonth = {
  label: string
  mean: number | null
  p05: number | null
  p95: number | null
}

export type AnnualPoint = {
  year: number
  total: number | null
  partial: boolean
  anomaly: number | null
}

export type RegionSeries = {
  id: string
  name: string
  color: string
  ring: LonLat[]
  counts: (number | null)[][]
  rawModis: (number | null)[][]
  rawViirs: (number | null)[][]
  insights: string[]
  metrics: RegionMetrics
  climatology: ClimatologyMonth[]
  annual: AnnualPoint[]
  peakMonthLabel: string
}

export type DataMode = 'real' | 'mock' | 'unknown'

/** Metadados do dataset servido pela API. A interface lê daqui em vez de fixar anos e versões. */
export type DatasetMeta = {
  mode: DataMode
  methodVersion: string
  datasetVersion: string
  currentYear: number
  baselineFrom: number
  baselineTo: number
  calibrationWindow: string
  periodStart: string | null
  periodEnd: string | null
  lastCompleteYear: number | null
  warnings: string[]
}

export type Workspace = {
  years: number[]
  months: string[]
  /** Células exibidas nos chips/calculadora/mapa de calor (as mais ativas). */
  regions: RegionSeries[]
  /** Grade completa, usada apenas no recorte por AOI/polígono. */
  allRegions?: RegionSeries[]
  hotspots: Hotspot[]
  disclaimer: string
  meta: DatasetMeta
}
