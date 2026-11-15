export type LonLat = [number, number]

export type Hotspot = {
  id: string
  date: string
  regionId: string
  sensor: string
  platform: string
  frp: number
  confidence: number
  lon: number
  lat: number
}

export type RegionMetrics = {
  biome: string
  currentYearTotal: number
  currentYearAnomaly: number
  peakYear: number
  peakYearTotal: number
  trendPctDecade: number
  trendWindow: string
  modisPct: number
  viirsPct: number
  modisRaw: number
  viirsRaw: number
  factor: number
  uncertaintyPct: number
  confidence: string
  baselineMeanAnnual: number
}

export type ClimatologyMonth = {
  label: string
  mean: number
  p05: number
  p95: number
}

export type AnnualPoint = {
  year: number
  total: number
  partial: boolean
  anomaly: number
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

export type Workspace = {
  years: number[]
  months: string[]
  regions: RegionSeries[]
  hotspots: Hotspot[]
  disclaimer: string
}
