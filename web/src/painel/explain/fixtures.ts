// Fixtures pequenos e determinísticos para os testes de lib/ e explain/. Não entram no bundle da UI
// (nada os importa fora de *.test.ts).
import type { AnnualPoint, ClimatologyMonth, LonLat, RegionMetrics, RegionSeries } from '../types'
import type { PanelText } from '../lib/panelText'

export const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
export const CURRENT_YEAR = 2026
export const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** Perfil mensal base (soma 265). Cada ano é este perfil vezes um multiplicador. */
export const PROFILE = [0, 0, 0, 0, 10, 20, 50, 100, 60, 20, 5, 0]

export const text: PanelText = {
  t: ((key: string) => key) as PanelText['t'],
  locale: 'pt-BR',
  monthShort: MONTHS,
  monthLong: MONTHS,
}

/** Matriz anos x 12 meses. multipliers[i] === null gera ano sem dado algum. */
export function makeCounts(
  multipliers: (number | null)[],
  nulls: Array<[yearIndex: number, month: number]> = [],
): (number | null)[][] {
  const grid = multipliers.map((k) => PROFILE.map((value) => (k === null ? null : value * k)))
  for (const [yearIndex, month] of nulls) grid[yearIndex][month] = null
  return grid
}

function annualOf(counts: (number | null)[][], years: number[]): AnnualPoint[] {
  return years.map((year, index) => {
    const known = counts[index].filter((value): value is number => value !== null)
    return {
      year,
      total: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
      partial: known.length < 12,
      anomaly: null,
    }
  })
}

export function baseMetrics(overrides: Partial<RegionMetrics> = {}): RegionMetrics {
  return {
    biome: 'Cerrado',
    currentYearTotal: null,
    currentYearAnomaly: null,
    peakYear: null,
    peakYearTotal: null,
    trendPctDecade: null,
    trendWindow: '',
    modisPct: 0,
    viirsPct: 100,
    modisRaw: 0,
    viirsRaw: 0,
    factor: 1,
    uncertaintyPct: 100,
    confidence: 'low',
    baselineMeanAnnual: null,
    ...overrides,
  }
}

export function makeRegion(
  id: string,
  counts: (number | null)[][],
  ring: LonLat[],
  metrics: Partial<RegionMetrics> = {},
  years: number[] = YEARS,
): RegionSeries {
  const climatology: ClimatologyMonth[] = MONTHS.map((label, month) => {
    const values = counts
      .filter((_, index) => years[index] >= 2018 && years[index] <= 2024)
      .map((row) => row[month])
      .filter((value): value is number => value !== null)
    if (values.length === 0) return { label, mean: null, p05: null, p95: null }
    return { label, mean: values.reduce((a, b) => a + b, 0) / values.length, p05: Math.min(...values), p95: Math.max(...values) }
  })
  return {
    id,
    name: `Região ${id}`,
    color: '#fff',
    ring,
    counts,
    rawModis: counts.map((row) => row.map((value) => (value === null ? null : value / 4))),
    rawViirs: counts.map((row) => row.map((value) => (value === null ? null : (value * 3) / 4))),
    insights: [],
    metrics: baseMetrics(metrics),
    climatology,
    annual: annualOf(counts, years),
    peakMonthLabel: 'ago',
  }
}

export const RING_A: LonLat[] = [[0, 0], [1, 0], [1, 1], [0, 1]]
export const RING_B: LonLat[] = [[1, 0], [2, 0], [2, 1], [1, 1]]
/** Cobre metade de A e metade de B (pesos 0,5 / 0,5). */
export const POLYGON_AB: LonLat[] = [[0.5, 0.2], [1.5, 0.2], [1.5, 0.8], [0.5, 0.8]]

/** Multiplicadores 2018..2026. 2026 só tem jan–out (nov e dez null) e 2018/jan é null. */
export const MULTIPLIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export function regionA(metrics: Partial<RegionMetrics> = {}): RegionSeries {
  const counts = makeCounts(MULTIPLIERS, [[0, 0], [8, 10], [8, 11]])
  return makeRegion('a', counts, RING_A, { trendPctDecade: 10, baselineMeanAnnual: 1000, ...metrics })
}

export function regionB(metrics: Partial<RegionMetrics> = {}): RegionSeries {
  const counts = makeCounts([2, 2, 2, 2, 2, 2, 2, 3, 3], [[8, 11]])
  return makeRegion('b', counts, RING_B, { trendPctDecade: null, ...metrics })
}
