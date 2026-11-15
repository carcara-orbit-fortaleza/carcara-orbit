import type { Hotspot, LonLat, RegionSeries } from '../types'
import type { ForecastContext } from './forecast'
import { MAX_FACTOR, MIN_FACTOR, MIN_REFERENCE_YEARS } from './forecast'
import { mean } from './stats'

// Grade de chance de fogo por célula. Modelo explícito, nunca certeza:
//
//   λ_c = R_r × s_c × H × S_m          (focos esperados na célula c nos próximos H dias)
//   P_c = 1 − exp(−λ_c)                (chance de ao menos um foco, hipótese de Poisson)
//
// R_r  taxa diária de focos da região r na janela recente (focos / dias de exposição).
// s_c  fatia espacial da célula: contagem suavizada por núcleo 3×3 com prior uniforme
//      (pseudo-contagem) sobre as células da região, para que célula sem foco não vire zero.
// H    horizonte em dias.
// S_m  ajuste sazonal: climatologia do mês-alvo ÷ climatologia do mês corrente, só quando
//      a região tem anos de referência suficientes; senão 1 e `seasonal = false`.
// Hipótese central: o padrão espacial dos últimos dias se repete no horizonte escolhido.
//
// Detalhes que a interface precisa saber:
// - Células: toda célula CELL_DEG cujo CENTRO cai dentro do anel de uma região, atribuída à
//   primeira região (na ordem de `regions`) que a contém.
// - Foco entra na célula que o contém (cellIdFor). Foco cuja célula não foi calculada (fora de
//   todos os anéis, ou dentro do anel mas numa célula de borda com centro fora) é ignorado nas
//   fatias E na taxa regional: não conta em lugar nenhum. `Hotspot.regionId` não é usado; vale a
//   geometria da grade.
// - Janela: focos com data parseável (YYYY-MM-DD no início). Só entram os focos dos últimos
//   RECENT_WINDOW_DAYS dias antes da detecção mais recente: amostra antiga misturaria estações e
//   diluiria a taxa. windowFrom/windowTo = menor/maior dia dentro desse corte. Datas inválidas são
//   ignoradas em tudo (janela, contagens).
// - Exposição: do instante do primeiro foco da janela (ts quando existe, senão 00:00 UTC do dia)
//   até nowMs, mas nunca além do fim do dia UTC do último foco: feed parado não conta como dias
//   sem fogo. Com o feed cortado (só os N mais novos), o início é o ponto do corte, não a meia-noite.
//   Em dias, com fração, mínimo 1 (datas no futuro não geram negativo).
// - R_r = focos contados da região ÷ exposureDays.
// - Suavização: smoothed_c = observed_c + NEIGHBOR_WEIGHT × Σ observed dos 8 vizinhos (vizinho
//   fora da grade conta 0; vizinho de outra região conta, o fogo não respeita fronteira).
// - s_c = (smoothed_c + PRIOR_STRENGTH / n_r) ÷ (Σ_r smoothed + PRIOR_STRENGTH): soma 1 na região.
// - S_m: mês-alvo = mês UTC de nowMs + H/2 dias. Meses de referência = meses cobertos pela janela,
//   pesados pelos dias (janela vazia ou no futuro: mês de nowMs). Usa a matriz `counts` da região
//   (linhas alinhadas a `annual`) nos anos de context.baseline com valor em todos esses meses.
//   Precisa de ≥ MIN_REFERENCE_YEARS desses anos e média de referência > 0; então
//   S = média(alvo) ÷ média ponderada(referência), limitado a [MIN_FACTOR, MAX_FACTOR].
// - Faixa pLow–pHigh: faixa aproximada de 90% da taxa. Junta o ruído de contagem (Poisson sobre a
//   contagem regional N) e a variação dia a dia, assumida com coeficiente de variação
//   DAILY_RATE_CV até haver histórico para medi-la: erro relativo em log √(1/N + CV²/exposureDays).
//   Vale a mais larga entre essa faixa log-normal e o intervalo de Garwood (N = 0: taxa baixa 0 e
//   alta = −ln(0,05) ÷ exposureDays). Não cobre a hipótese de que o padrão espacial se repete nem
//   a falta de calibração: o erro real pode ser maior.
// - Confiança: 'low' se exposureDays < MIN_WINDOW_DAYS_FOR_MEDIUM ou nenhuma região com células
//   tem sazonalidade; 'high' só com janela ≥ HIGH_CONFIDENCE_WINDOW_DAYS, todas as regiões com
//   células sazonais e feed completo (incompleteFeed falso); senão 'medium'.
// - A interface nunca deve mostrar chance de 0% ou 100%: use formatChance (lib/format.ts).

/** Lado da célula em graus (~28 km no equador). */
export const CELL_DEG = 0.25
/** Horizontes oferecidos na interface, em dias. */
export const GRID_HORIZONS = [1, 7, 30] as const
export type GridHorizon = (typeof GRID_HORIZONS)[number]
/** Pseudo-contagem total do prior uniforme, por região. */
export const PRIOR_STRENGTH = 1
/** Peso dos 8 vizinhos no núcleo de suavização (a célula central pesa 1). */
export const NEIGHBOR_WEIGHT = 0.5
/** Abaixo disto a célula não é desenhada (o dado continua no resultado). */
export const MIN_DRAW_P = 0.01
/** Janela recente mais curta que isto deixa a confiança sempre baixa. */
export const MIN_WINDOW_DAYS_FOR_MEDIUM = 7

/** Janela mínima (dias) para a confiança poder ser 'high'. */
export const HIGH_CONFIDENCE_WINDOW_DAYS = 30
/** Nível do intervalo de Poisson da faixa pLow–pHigh (P05–P95). */
export const GRID_INTERVAL_LEVEL = 0.9
/** Só os focos destes últimos dias (contados da detecção mais recente) entram na taxa. */
export const RECENT_WINDOW_DAYS = 60
/** Coeficiente de variação assumido para a contagem diária de focos (fogo varia muito de um dia para outro). */
export const DAILY_RATE_CV = 1

/**
 * Chaves de ressalva possíveis em FireGrid.caveats:
 * - 'short-window'   janela recente menor que MIN_WINDOW_DAYS_FOR_MEDIUM dias: a taxa é instável.
 * - 'no-seasonality' nenhuma região com células tem histórico suficiente; S_m = 1 em todas.
 * - 'no-hotspots'    nenhum foco caiu em célula calculada; todas as chances são 0 (só pHigh > 0).
 * - 'incomplete-feed' os focos são amostra ou foram cortados pelo limite da API: a taxa fica baixa.
 * - 'not-calibrated' sempre presente: o modelo ainda não foi calibrado contra o que de fato queimou.
 */
export const GRID_CAVEATS = ['short-window', 'no-seasonality', 'no-hotspots', 'incomplete-feed', 'not-calibrated'] as const

export type GridConfidence = 'low' | 'medium' | 'high'

export type FireCell = {
  /** "lonIndex:latIndex" na grade CELL_DEG. Estável entre recomputações. */
  id: string
  regionId: string
  /** Canto sudoeste e nordeste da célula. */
  bounds: [LonLat, LonLat]
  center: LonLat
  /** Focos observados na célula durante a janela. */
  observed: number
  /** Contagem suavizada (núcleo 3×3) usada na fatia espacial. */
  smoothed: number
  /** s_c: fatia da célula na região (0..1). */
  share: number
  /** λ_c: focos esperados no horizonte. */
  expected: number
  /** P_c = 1 − exp(−λ_c). */
  p: number
  /** Faixa aproximada de 90% de P_c: ruído de contagem + variação diária (não inclui erro de calibração). */
  pLow: number
  pHigh: number
}

export type FireGridRegionSummary = {
  regionId: string
  /** Focos da região na janela. */
  windowCount: number
  /** R_r em focos/dia. */
  dailyRate: number
  /** S_m aplicado (1 quando não há sazonalidade). */
  seasonalFactor: number
  seasonal: boolean
  cells: number
}

export type FireGrid = {
  horizonDays: number
  /** Primeiro e último dia (YYYY-MM-DD) com foco na janela; null sem focos. */
  windowFrom: string | null
  windowTo: string | null
  /** Dias de exposição usados no denominador de R (≥ 1, aceita fração para o dia em curso). */
  exposureDays: number
  /** Mês-alvo (0..11) usado no ajuste sazonal. */
  targetMonth: number
  cells: FireCell[]
  regions: FireGridRegionSummary[]
  confidence: GridConfidence
  /** Chaves de ressalva (i18n) que a interface deve mostrar, ex.: 'short-window', 'no-seasonality'. */
  caveats: string[]
}

export type FireGridInput = {
  hotspots: Hotspot[]
  regions: RegionSeries[]
  context: ForecastContext
  horizonDays: number
  /**
   * Instante de referência em ms (fim da janela). Passado de fora para manter a função pura. Deve ser
   * o fim do dado (última detecção ou geração do feed), não a hora em que a página abriu.
   */
  nowMs: number
  /** Os focos são amostra ou vieram cortados (returned < total): sem confiança 'high' e com ressalva. */
  incompleteFeed?: boolean
}

export function buildFireGrid(input: FireGridInput): FireGrid {
  const { hotspots, regions, context, horizonDays, nowMs } = input

  // 1. Células: centros dentro dos anéis, primeira região vence.
  const index = new Map<number, Slot>()
  const regionCells = new Map<string, Slot[]>()
  for (const region of regions) {
    const slots: Slot[] = []
    regionCells.set(region.id, slots)
    for (const [i, j] of cellsInRing(region.ring)) {
      const key = cellKey(i, j)
      if (index.has(key)) continue
      const slot: Slot = { i, j, regionId: region.id, observed: 0 }
      index.set(key, slot)
      slots.push(slot)
    }
  }

  // 2. Janela recente: instantes válidos, corte nos últimos RECENT_WINDOW_DAYS dias.
  const times: number[] = new Array(hotspots.length)
  let lastMs: number | null = null
  for (let k = 0; k < hotspots.length; k++) {
    const ms = hotspotTime(hotspots[k])
    times[k] = ms ?? Number.NaN
    if (ms !== null && (lastMs === null || ms > lastMs)) lastMs = ms
  }
  const cutMs = lastMs === null ? -Infinity : lastMs - RECENT_WINDOW_DAYS * DAY_MS
  let fromMs: number | null = null
  let fromDay: number | null = null
  let toDay: number | null = null
  for (let k = 0; k < hotspots.length; k++) {
    const ms = times[k]
    if (!Number.isFinite(ms) || ms < cutMs) continue
    const day = ms - mod(ms, DAY_MS)
    if (fromMs === null || ms < fromMs) fromMs = ms
    if (fromDay === null || day < fromDay) fromDay = day
    if (toDay === null || day > toDay) toDay = day
    const hotspot = hotspots[k]
    if (!Number.isFinite(hotspot.lon) || !Number.isFinite(hotspot.lat)) continue
    const slot = index.get(cellKey(cellIndex(hotspot.lon), cellIndex(hotspot.lat)))
    if (slot) slot.observed++
  }
  // Fim da exposição: nowMs, mas nunca além do fim do dia do último foco (feed parado ≠ dias sem fogo).
  const endMs = toDay === null ? nowMs : Math.min(nowMs, toDay + DAY_MS)
  const exposureDays = fromMs === null ? 1 : Math.max(1, (endMs - fromMs) / DAY_MS)

  // 3. Sazonalidade: meses cobertos pela janela (ou o de nowMs) contra o mês-alvo.
  const referenceMonths = fromMs !== null && endMs > fromMs ? monthWeights(fromMs, endMs) : [{ month: new Date(nowMs).getUTCMonth(), weight: 1 }]
  const targetMonth = new Date(nowMs + (horizonDays / 2) * DAY_MS).getUTCMonth()

  const cells: FireCell[] = []
  const summaries: FireGridRegionSummary[] = []
  let totalCounted = 0
  let regionsWithCells = 0
  let seasonalRegions = 0

  for (const region of regions) {
    const slots = regionCells.get(region.id) ?? []
    const season = seasonalFactor(region, context, referenceMonths, targetMonth)
    let windowCount = 0
    let smoothedSum = 0
    const smoothed = slots.map((slot) => {
      windowCount += slot.observed
      let neighbors = 0
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue
          neighbors += index.get(cellKey(slot.i + di, slot.j + dj))?.observed ?? 0
        }
      }
      const value = slot.observed + NEIGHBOR_WEIGHT * neighbors
      smoothedSum += value
      return value
    })
    const dailyRate = windowCount / exposureDays
    summaries.push({
      regionId: region.id,
      windowCount,
      dailyRate,
      seasonalFactor: season.factor,
      seasonal: season.seasonal,
      cells: slots.length,
    })
    if (slots.length === 0) continue
    regionsWithCells++
    if (season.seasonal) seasonalRegions++
    totalCounted += windowCount

    const [lowRate, highRate] = rateInterval(windowCount, exposureDays)
    const prior = PRIOR_STRENGTH / slots.length
    const denominator = smoothedSum + PRIOR_STRENGTH
    const scale = horizonDays * season.factor

    slots.forEach((slot, k) => {
      const share = (smoothed[k] + prior) / denominator
      const expected = dailyRate * share * scale
      const p = chance(expected)
      const west = slot.i * CELL_DEG
      const south = slot.j * CELL_DEG
      cells.push({
        id: `${slot.i}:${slot.j}`,
        regionId: region.id,
        bounds: [
          [west, south],
          [west + CELL_DEG, south + CELL_DEG],
        ],
        center: [west + CELL_DEG / 2, south + CELL_DEG / 2],
        observed: slot.observed,
        smoothed: smoothed[k],
        share,
        expected,
        p,
        pLow: Math.min(p, chance(lowRate * share * scale)),
        pHigh: Math.max(p, chance(highRate * share * scale)),
      })
    })
  }

  // 4. Confiança e ressalvas.
  const shortWindow = exposureDays < MIN_WINDOW_DAYS_FOR_MEDIUM
  const noSeasonality = seasonalRegions === 0
  let confidence: GridConfidence = 'medium'
  if (shortWindow || noSeasonality) confidence = 'low'
  else if (exposureDays >= HIGH_CONFIDENCE_WINDOW_DAYS && seasonalRegions === regionsWithCells && !input.incompleteFeed) {
    confidence = 'high'
  }
  const caveats: string[] = []
  if (shortWindow) caveats.push('short-window')
  if (noSeasonality) caveats.push('no-seasonality')
  if (totalCounted === 0) caveats.push('no-hotspots')
  if (input.incompleteFeed) caveats.push('incomplete-feed')
  caveats.push('not-calibrated')

  return {
    horizonDays,
    windowFrom: fromDay === null ? null : isoDay(fromDay),
    windowTo: toDay === null ? null : isoDay(toDay),
    exposureDays,
    targetMonth,
    cells,
    regions: summaries,
    confidence,
    caveats,
  }
}

/** Célula que contém o ponto, ou null fora da grade calculada. */
export function cellAt(grid: FireGrid, lon: number, lat: number): FireCell | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  let byId = cellIndexCache.get(grid)
  if (!byId) {
    byId = new Map(grid.cells.map((cell) => [cell.id, cell]))
    cellIndexCache.set(grid, byId)
  }
  return byId.get(cellIdFor(lon, lat)) ?? null
}

/** Id da célula na grade CELL_DEG para um ponto. */
export function cellIdFor(lon: number, lat: number): string {
  return `${cellIndex(lon)}:${cellIndex(lat)}`
}

// ---------------------------------------------------------------------------------------------
// Internos

const DAY_MS = 86_400_000
// Deslocamento para chave numérica: índices cabem com folga em ±2^15 (±8192° com CELL_DEG 0,25).
const KEY_OFFSET = 32_768
const KEY_SPAN = 65_536

type Slot = { i: number; j: number; regionId: string; observed: number }

// Índice por objeto de grade: construído na primeira consulta, liberado junto com a grade.
const cellIndexCache = new WeakMap<FireGrid, Map<string, FireCell>>()

function cellIndex(coord: number): number {
  return Math.floor(coord / CELL_DEG)
}

function cellKey(i: number, j: number): number {
  return (i + KEY_OFFSET) * KEY_SPAN + (j + KEY_OFFSET)
}

function chance(expected: number): number {
  return expected > 0 ? 1 - Math.exp(-expected) : 0
}

/**
 * Índices (i, j) das células cujo centro está dentro do anel. Varredura por linha: para cada
 * latitude de centro, acha os cruzamentos das arestas (mesma regra de pointInRing) e testa só os
 * centros da caixa envolvente, sem percorrer o anel inteiro por célula.
 */
function cellsInRing(ring: LonLat[]): [number, number][] {
  const out: [number, number][] = []
  const n = ring.length
  if (n < 3) return out
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  if (!Number.isFinite(minLon + maxLon + minLat + maxLat)) return out
  const i0 = cellIndex(minLon)
  const i1 = cellIndex(maxLon)
  const xs: number[] = []
  for (let j = cellIndex(minLat); j <= cellIndex(maxLat); j++) {
    const lat = (j + 0.5) * CELL_DEG
    xs.length = 0
    // Anel aberto ou fechado: a aresta degenerada último→primeiro de um anel fechado não cruza.
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const [xa, ya] = ring[a]
      const [xb, yb] = ring[b]
      if (ya > lat !== yb > lat) xs.push(((xb - xa) * (lat - ya)) / (yb - ya) + xa)
    }
    if (xs.length === 0) continue
    xs.sort((p, q) => p - q)
    // Dentro quando o número de cruzamentos com x > lon é ímpar (lon < x estrito, como pointInRing).
    let k = 0
    for (let i = i0; i <= i1; i++) {
      const lon = (i + 0.5) * CELL_DEG
      while (k < xs.length && xs[k] <= lon) k++
      if ((xs.length - k) % 2 === 1) out.push([i, j])
    }
  }
  return out
}

/** Início do dia UTC (ms) de uma data "YYYY-MM-DD..." ou null se não der para ler. */
function parseDay(date: string): number | null {
  if (typeof date !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const ms = Date.UTC(year, month, day)
  const check = new Date(ms)
  // Rejeita datas que o Date "conserta" (ex.: 2026-02-31).
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null
  return ms
}

/**
 * Instante do foco em ms: `ts` (ISO) quando existe e cai no mesmo dia de `date`; senão 00:00 UTC
 * de `date`. null quando a data não dá para ler.
 */
function hotspotTime(hotspot: Hotspot): number | null {
  const day = parseDay(hotspot.date)
  if (day === null) return null
  const ts = typeof hotspot.ts === 'string' ? Date.parse(hotspot.ts) : Number.NaN
  return Number.isFinite(ts) && ts >= day && ts < day + DAY_MS ? ts : day
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * S_m da região. Anos usados: dentro de context.baseline, com valor no mês-alvo e em todos os meses
 * de referência. As linhas de `counts` seguem a ordem de `annual` (mesma convenção dos fixtures e da API).
 */
function seasonalFactor(
  region: RegionSeries,
  context: ForecastContext,
  referenceMonths: MonthWeight[],
  targetMonth: number,
): { factor: number; seasonal: boolean } {
  const current: number[] = []
  const target: number[] = []
  const years = region.annual ?? []
  const totalWeight = referenceMonths.reduce((sum, item) => sum + item.weight, 0)
  for (let row = 0; row < years.length; row++) {
    const year = years[row].year
    if (year < context.baseline.from || year > context.baseline.to) continue
    const then = region.counts?.[row]?.[targetMonth] ?? null
    if (then === null) continue
    let reference = 0
    let complete = true
    for (const { month, weight } of referenceMonths) {
      const value = region.counts?.[row]?.[month] ?? null
      if (value === null) {
        complete = false
        break
      }
      reference += value * weight
    }
    if (!complete) continue
    current.push(reference / totalWeight)
    target.push(then)
  }
  if (current.length < MIN_REFERENCE_YEARS) return { factor: 1, seasonal: false }
  const currentMean = mean(current)
  if (!(currentMean > 0)) return { factor: 1, seasonal: false }
  const raw = mean(target) / currentMean
  return { factor: Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, raw)), seasonal: true }
}

type MonthWeight = { month: number; weight: number }

/** Meses UTC cobertos por [fromMs, toMs), cada um pesado pela fração de dias que a janela passa nele. */
function monthWeights(fromMs: number, toMs: number): MonthWeight[] {
  const weights = new Map<number, number>()
  let cursor = fromMs
  while (cursor < toMs) {
    const date = new Date(cursor)
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    const stop = Math.min(nextMonth, toMs)
    const month = date.getUTCMonth()
    weights.set(month, (weights.get(month) ?? 0) + (stop - cursor))
    cursor = stop
  }
  return [...weights].map(([month, weight]) => ({ month, weight }))
}

/**
 * Faixa aproximada de 90% da taxa diária: a mais larga entre o intervalo de Garwood da contagem e
 * uma faixa log-normal com ruído de contagem + variação dia a dia (DAILY_RATE_CV).
 */
export function rateInterval(count: number, exposureDays: number, level = GRID_INTERVAL_LEVEL): [number, number] {
  const days = Math.max(1, exposureDays)
  const [lowCount, highCount] = poissonInterval(count, level)
  if (count <= 0) return [0, highCount / days]
  const rate = count / days
  const z = normalQuantile(1 - (1 - level) / 2)
  const spread = Math.exp(z * Math.sqrt(1 / count + (DAILY_RATE_CV * DAILY_RATE_CV) / days))
  return [Math.min(lowCount / days, rate / spread), Math.max(highCount / days, rate * spread)]
}

/**
 * Intervalo de Garwood para uma contagem de Poisson (nível `level`, bicaudal):
 * baixo = χ²(α/2; 2N)/2, alto = χ²(1−α/2; 2N+2)/2, com χ² por Wilson–Hilferty.
 * N = 0: baixo 0 e alto exato −ln(α/2).
 */
export function poissonInterval(count: number, level = GRID_INTERVAL_LEVEL): [number, number] {
  const alpha = 1 - level
  if (count <= 0) return [0, -Math.log(alpha / 2)]
  const z = normalQuantile(1 - alpha / 2)
  const low = chiSquareQuantile(2 * count, -z) / 2
  const high = chiSquareQuantile(2 * count + 2, z) / 2
  return [Math.max(0, Math.min(count, low)), Math.max(count, high)]
}

function chiSquareQuantile(df: number, z: number): number {
  const c = 2 / (9 * df)
  const base = 1 - c + z * Math.sqrt(c)
  return base <= 0 ? 0 : df * base * base * base
}

/** Quantil da normal padrão (Acklam), precisão ~1e-9: suficiente para a faixa. */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p)
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}
