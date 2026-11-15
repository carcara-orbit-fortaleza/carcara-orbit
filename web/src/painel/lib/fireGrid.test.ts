// Testes da grade de chance por célula (fireGrid.ts). Fixtures sintéticas e determinísticas:
// anéis quadrados em coordenadas negativas (como o Brasil) e calendários de explain/fixtures.
import { describe, expect, it } from 'vitest'
import type { Hotspot, LonLat } from '../types'
import {
  CELL_DEG,
  HIGH_CONFIDENCE_WINDOW_DAYS,
  MIN_DRAW_P,
  MIN_WINDOW_DAYS_FOR_MEDIUM,
  RECENT_WINDOW_DAYS,
  NEIGHBOR_WEIGHT,
  buildFireGrid,
  cellAt,
  cellIdFor,
  poissonInterval,
  rateInterval,
  type FireGridInput,
} from './fireGrid'
import { MAX_FACTOR, MIN_FACTOR } from './forecast'
import { formatChance } from './format'
import { pointInRing } from './geo'
import { makeCounts, makeRegion, YEARS } from '../explain/fixtures'

const DAY = 86_400_000
const context = { currentYear: 2026, baseline: { from: 2018, to: 2024 } }

// 2° × 2° = 8 × 8 células cada; B fica a leste de A.
const RING_A: LonLat[] = [[-50, -10], [-48, -10], [-48, -8], [-50, -8]]
const RING_B: LonLat[] = [[-48, -10], [-46, -10], [-46, -8], [-48, -8]]

/** Região com histórico completo 2018..2026 (perfil mensal de fixtures). */
function withHistory(id: string, ring: LonLat[]) {
  return makeRegion(id, makeCounts([1, 2, 3, 4, 5, 6, 7, 8, 9]), ring)
}

/** Região sem histórico algum (caso do modo real hoje). */
function noHistory(id: string, ring: LonLat[]) {
  return makeRegion(id, makeCounts(YEARS.map(() => null)), ring)
}

let seq = 0
function hotspot(lon: number, lat: number, date = '2026-11-14', ts?: string): Hotspot {
  seq++
  return { id: `h${seq}`, date, ts, regionId: 'x', sensor: 'VIIRS', platform: 'N20', frp: null, confidence: null, lon, lat }
}

function input(overrides: Partial<FireGridInput> = {}): FireGridInput {
  return {
    hotspots: [hotspot(-49.1, -9.1), hotspot(-49.1, -9.1), hotspot(-49.3, -9.05), hotspot(-47.3, -8.6)],
    regions: [noHistory('a', RING_A), noHistory('b', RING_B)],
    context,
    horizonDays: 7,
    nowMs: Date.UTC(2026, 10, 15, 12),
    ...overrides,
  }
}

describe('cellIdFor / cellAt', () => {
  it('usa floor(coord / CELL_DEG), inclusive em coordenadas negativas e nas bordas', () => {
    expect(cellIdFor(0, 0)).toBe('0:0')
    expect(cellIdFor(0.2499, 0.25)).toBe('0:1')
    expect(cellIdFor(-0.0001, -0.0001)).toBe('-1:-1')
    expect(cellIdFor(-49, -9)).toBe('-196:-36')
    expect(cellIdFor(-49.01, -9.01)).toBe('-197:-37')
  })

  it('ida e volta: o centro e os cantos (SW incluso, NE exclusivo) voltam para a mesma célula', () => {
    const grid = buildFireGrid(input())
    expect(grid.cells.length).toBe(128)
    for (const cell of grid.cells) {
      expect(cellIdFor(...cell.center)).toBe(cell.id)
      expect(cellAt(grid, ...cell.center)).toBe(cell)
      expect(cellAt(grid, cell.bounds[0][0], cell.bounds[0][1])).toBe(cell)
      expect(cellAt(grid, cell.bounds[1][0], cell.bounds[1][1])?.id).not.toBe(cell.id)
      expect(cell.bounds[1][0] - cell.bounds[0][0]).toBeCloseTo(CELL_DEG, 12)
    }
    expect(cellAt(grid, 10, 10)).toBeNull()
    expect(cellAt(grid, Number.NaN, -9)).toBeNull()
  })
})

describe('células e atribuição de região', () => {
  it('células são exatamente as de centro dentro do anel, primeira região vence', () => {
    const triangle: LonLat[] = [[-50, -10], [-47, -10], [-50, -7], [-50, -10]]
    const grid = buildFireGrid(input({ regions: [noHistory('t', triangle), noHistory('a', RING_A)] }))
    for (const cell of grid.cells) {
      if (cell.regionId === 't') expect(pointInRing(cell.center[0], cell.center[1], triangle)).toBe(true)
    }
    // Força bruta: toda célula da caixa com centro dentro do triângulo foi gerada para 't'.
    let expected = 0
    for (let i = -200; i < -188; i++) {
      for (let j = -40; j < -28; j++) {
        if (pointInRing((i + 0.5) * CELL_DEG, (j + 0.5) * CELL_DEG, triangle)) expected++
      }
    }
    expect(grid.cells.filter((c) => c.regionId === 't').length).toBe(expected)
    // A só fica com as células dela que o triângulo não pegou.
    const ids = new Set(grid.cells.map((c) => c.id))
    expect(ids.size).toBe(grid.cells.length)
    let leftForA = 0
    for (let i = -200; i < -192; i++) {
      for (let j = -40; j < -32; j++) {
        if (!pointInRing((i + 0.5) * CELL_DEG, (j + 0.5) * CELL_DEG, triangle)) leftForA++
      }
    }
    expect(grid.regions.find((r) => r.regionId === 'a')?.cells).toBe(leftForA)
  })

  it('focos fora de todos os anéis e com data ruim não contam', () => {
    const base = buildFireGrid(input())
    const noisy = buildFireGrid(
      input({
        hotspots: [
          ...input().hotspots,
          hotspot(-30, -5),
          hotspot(-49.1, -9.1, 'ontem'),
          hotspot(-49.1, -9.1, '2026-02-31'),
          hotspot(-49.1, -9.1, ''),
        ],
      }),
    )
    expect(noisy.regions).toEqual(base.regions)
    expect(noisy.cells).toEqual(base.cells)
    // O foco fora dos anéis tem data válida: ele ainda define a janela (cobertura do feed).
    expect(noisy.windowFrom).toBe('2026-11-14')
  })
})

describe('fatias espaciais', () => {
  it('somam 1 por região e a suavização segue o núcleo 3×3', () => {
    const grid = buildFireGrid(input())
    for (const region of ['a', 'b']) {
      const total = grid.cells.filter((c) => c.regionId === region).reduce((sum, c) => sum + c.share, 0)
      expect(total).toBeCloseTo(1, 12)
    }
    const hot = cellAt(grid, -49.1, -9.1)!
    expect(hot.observed).toBe(2)
    // (-49.3, -9.05) cai na célula vizinha a oeste: entra com NEIGHBOR_WEIGHT.
    expect(hot.smoothed).toBeCloseTo(2 + NEIGHBOR_WEIGHT * 1, 12)
    expect(grid.regions.find((r) => r.regionId === 'a')?.windowCount).toBe(3)
  })

  it('célula sem foco tem chance > 0, mas pequena perto das quentes', () => {
    const grid = buildFireGrid(input())
    const empty = cellAt(grid, -49.9, -9.9)!
    const hot = cellAt(grid, -49.1, -9.1)!
    expect(empty.observed).toBe(0)
    expect(empty.smoothed).toBe(0)
    expect(empty.p).toBeGreaterThan(0)
    expect(empty.p).toBeLessThan(0.05)
    expect(hot.p).toBeGreaterThan(empty.p * 10)
  })
})

describe('chance, faixa e horizonte', () => {
  it('p = 1 − exp(−expected) e expected = R × s × H × S', () => {
    const grid = buildFireGrid(input())
    const a = grid.regions.find((r) => r.regionId === 'a')!
    for (const cell of grid.cells.filter((c) => c.regionId === 'a')) {
      expect(cell.expected).toBeCloseTo(a.dailyRate * cell.share * 7 * a.seasonalFactor, 12)
      expect(cell.p).toBeCloseTo(1 - Math.exp(-cell.expected), 12)
    }
  })

  it('p cresce com o horizonte', () => {
    const ps = [1, 7, 30].map((h) => cellAt(buildFireGrid(input({ horizonDays: h })), -49.1, -9.1)!.p)
    expect(ps[0]).toBeLessThan(ps[1])
    expect(ps[1]).toBeLessThan(ps[2])
  })

  it('0 ≤ pLow ≤ p ≤ pHigh ≤ 1 em todas as células, inclusive região sem foco', () => {
    const grid = buildFireGrid(input({ hotspots: [hotspot(-49.1, -9.1)], horizonDays: 30 }))
    for (const cell of grid.cells) {
      expect(cell.pLow).toBeGreaterThanOrEqual(0)
      expect(cell.pLow).toBeLessThanOrEqual(cell.p)
      expect(cell.p).toBeLessThanOrEqual(cell.pHigh)
      expect(cell.pHigh).toBeLessThanOrEqual(1)
    }
    // B não tem foco: chance central 0, mas a faixa alta não é zero (N = 0 não prova ausência).
    const b = grid.cells.filter((c) => c.regionId === 'b')
    expect(b.every((c) => c.p === 0 && c.pLow === 0 && c.pHigh > 0)).toBe(true)
  })

  it('intervalo de Poisson próximo dos valores exatos de Garwood (90%)', () => {
    expect(poissonInterval(0)[0]).toBe(0)
    expect(poissonInterval(0)[1]).toBeCloseTo(2.996, 3)
    const [low1, high1] = poissonInterval(1)
    expect(low1).toBeCloseTo(0.0513, 1)
    expect(high1).toBeCloseTo(4.744, 1)
    const [low10, high10] = poissonInterval(10)
    expect(low10).toBeCloseTo(5.426, 1)
    expect(high10).toBeCloseTo(16.962, 1)
  })
})

describe('janela de exposição', () => {
  it('conta do início do primeiro dia até nowMs, com fração', () => {
    const hotspots = [hotspot(-49.1, -9.1, '2026-11-14'), hotspot(-49.1, -9.1, '2026-11-15'), hotspot(-49.3, -9.05, '2026-11-15')]
    const grid = buildFireGrid(input({ hotspots }))
    expect(grid.windowFrom).toBe('2026-11-14')
    expect(grid.windowTo).toBe('2026-11-15')
    expect(grid.exposureDays).toBeCloseTo(1.5, 12)
    const a = grid.regions.find((r) => r.regionId === 'a')!
    expect(a.dailyRate).toBeCloseTo(3 / 1.5, 12)
  })

  it('feed parado: a janela termina no fim do dia do último foco, não em nowMs', () => {
    // Dado de um dia só, página aberta uma semana depois: a taxa não dilui e a ressalva continua.
    const hotspots = [hotspot(-49.1, -9.1, '2026-11-14'), hotspot(-49.1, -9.1, '2026-11-15', '2026-11-15T03:00:00Z')]
    const fresh = buildFireGrid(input({ hotspots, nowMs: Date.UTC(2026, 10, 15, 3, 9) }))
    const stale = buildFireGrid(input({ hotspots, nowMs: Date.UTC(2026, 10, 22, 3) }))
    expect(fresh.exposureDays).toBeCloseTo(1 + (3 * 60 + 9) / 1440, 9)
    expect(stale.exposureDays).toBe(2)
    expect(stale.caveats).toContain('short-window')
  })

  it('começa no instante do primeiro foco (ts), não na meia-noite: feed cortado não ganha horas vazias', () => {
    const hotspots = [
      hotspot(-49.1, -9.1, '2026-11-14', '2026-11-14T16:00:00Z'),
      hotspot(-49.1, -9.1, '2026-11-15', '2026-11-15T12:00:00Z'),
    ]
    const grid = buildFireGrid(input({ hotspots, nowMs: Date.UTC(2026, 10, 16, 16) }))
    expect(grid.exposureDays).toBeCloseTo(1 + 8 / 24, 9)
    // ts incoerente com a data é ignorado (vale a meia-noite do dia).
    const odd = buildFireGrid(input({ hotspots: [hotspot(-49.1, -9.1, '2026-11-14', '2026-12-01T00:00:00Z')], nowMs: Date.UTC(2026, 10, 14, 18) }))
    expect(odd.exposureDays).toBe(1)
  })

  it(`só usa os focos dos últimos ${RECENT_WINDOW_DAYS} dias antes da detecção mais recente`, () => {
    const last = Date.UTC(2026, 9, 28)
    const day = (offset: number) => new Date(last - offset * DAY).toISOString().slice(0, 10)
    const hotspots = [hotspot(-49.1, -9.1, day(0)), hotspot(-49.1, -9.1, day(10)), hotspot(-49.1, -9.1, day(RECENT_WINDOW_DAYS + 5))]
    const grid = buildFireGrid(input({ hotspots, nowMs: last + DAY }))
    expect(grid.windowFrom).toBe(day(10))
    expect(grid.regions.find((r) => r.regionId === 'a')?.windowCount).toBe(2)
    expect(grid.exposureDays).toBeCloseTo(11, 9)
  })

  it('nunca fica abaixo de 1, nem com data no futuro', () => {
    const now = Date.UTC(2026, 10, 15, 3)
    expect(buildFireGrid(input({ nowMs: now, hotspots: [hotspot(-49.1, -9.1, '2026-11-15')] })).exposureDays).toBe(1)
    expect(buildFireGrid(input({ nowMs: now, hotspots: [hotspot(-49.1, -9.1, '2027-01-01')] })).exposureDays).toBe(1)
    expect(buildFireGrid(input({ hotspots: [] })).exposureDays).toBe(1)
  })
})

describe('sazonalidade, confiança e ressalvas', () => {
  // 20/ago + 15 dias = setembro. Perfil: ago 100, set 60 → S = 0,6.
  const august = Date.UTC(2026, 7, 20)

  it('aplica S = média(alvo) / média(corrente) com ≥ 5 anos de referência', () => {
    const grid = buildFireGrid(input({ regions: [withHistory('a', RING_A), withHistory('b', RING_B)], horizonDays: 30, nowMs: august }))
    expect(grid.targetMonth).toBe(8)
    for (const region of grid.regions) {
      expect(region.seasonal).toBe(true)
      expect(region.seasonalFactor).toBeCloseTo(0.6, 12)
    }
  })

  it('limita S a [MIN_FACTOR, MAX_FACTOR] e desliga com mês corrente zerado', () => {
    // 15/jun + 30 dias → julho (50/20 = 2,5, dentro); 15/abr + 30 dias → mai com abr = 0: sem régua.
    const regions = [withHistory('a', RING_A)]
    const june = buildFireGrid(input({ regions, horizonDays: 60, nowMs: Date.UTC(2026, 5, 15) })).regions[0]
    expect(june.seasonalFactor).toBeCloseTo(2.5, 12)
    expect(june.seasonalFactor).toBeLessThanOrEqual(MAX_FACTOR)
    const april = buildFireGrid(input({ regions, horizonDays: 30, nowMs: Date.UTC(2026, 3, 15) })).regions[0]
    expect(april.seasonal).toBe(false)
    expect(april.seasonalFactor).toBe(1)
    // 20/out + 60 dias → dez (0): S = 0 vira MIN_FACTOR.
    const october = buildFireGrid(input({ regions, horizonDays: 120, nowMs: Date.UTC(2026, 9, 20) })).regions[0]
    expect(october.seasonalFactor).toBe(MIN_FACTOR)
  })

  it('sem histórico: S = 1, confiança baixa e ressalvas', () => {
    const grid = buildFireGrid(input())
    expect(grid.regions.every((r) => !r.seasonal && r.seasonalFactor === 1)).toBe(true)
    expect(grid.confidence).toBe('low')
    expect(grid.caveats).toEqual(['short-window', 'no-seasonality', 'not-calibrated'])
  })

  it('janela longa + sazonalidade: média; ≥ 30 dias e todas sazonais: alta', () => {
    const regions = [withHistory('a', RING_A), withHistory('b', RING_B)]
    const old = (days: number) => new Date(august - days * DAY).toISOString().slice(0, 10)
    const span = (days: number) => [hotspot(-49.1, -9.1, old(days)), hotspot(-49.1, -9.1, old(1))]
    const medium = buildFireGrid(input({ regions, nowMs: august, hotspots: span(MIN_WINDOW_DAYS_FOR_MEDIUM + 1) }))
    expect(medium.confidence).toBe('medium')
    expect(medium.caveats).toEqual(['not-calibrated'])
    const high = buildFireGrid(input({ regions, nowMs: august, hotspots: span(40) }))
    expect(high.confidence).toBe('high')
    const mixed = buildFireGrid(input({ regions: [regions[0], noHistory('b', RING_B)], nowMs: august, hotspots: span(40) }))
    expect(mixed.confidence).toBe('medium')
    // Amostra ou feed cortado: nunca 'high', e a ressalva aparece.
    const sample = buildFireGrid(input({ regions, nowMs: august, hotspots: span(40), incompleteFeed: true }))
    expect(sample.confidence).toBe('medium')
    expect(sample.caveats).toEqual(['incomplete-feed', 'not-calibrated'])
    expect(HIGH_CONFIDENCE_WINDOW_DAYS).toBeLessThan(RECENT_WINDOW_DAYS)
  })

  it('janela em vários meses: S compara o mês-alvo com a média dos meses da janela', () => {
    // Janela 1/jun..1/ago (jun 20, jul 50 no perfil; ~30 e ~31 dias), nowMs 31/jul, H = 30 → agosto (100).
    const regions = [withHistory('a', RING_A)]
    const hotspots = [hotspot(-49.1, -9.1, '2026-06-01'), hotspot(-49.1, -9.1, '2026-07-31')]
    const grid = buildFireGrid(input({ regions, hotspots, horizonDays: 30, nowMs: Date.UTC(2026, 7, 1) }))
    expect(grid.targetMonth).toBe(7)
    const reference = (20 * 30 + 50 * 31) / 61
    expect(grid.regions[0].seasonalFactor).toBeCloseTo(Math.min(MAX_FACTOR, 100 / reference), 9)
  })

  it('sem focos: ressalva no-hotspots e janela nula', () => {
    const grid = buildFireGrid(input({ hotspots: [] }))
    expect(grid.windowFrom).toBeNull()
    expect(grid.windowTo).toBeNull()
    expect(grid.caveats).toContain('no-hotspots')
    expect(grid.caveats).toContain('not-calibrated')
    expect(grid.cells.every((c) => c.p === 0)).toBe(true)
  })

  it('é pura: mesma entrada, mesma saída', () => {
    expect(buildFireGrid(input())).toEqual(buildFireGrid(input()))
  })
})

describe('nunca certeza', () => {
  // Volume próximo do real: ~4.000 focos em ~1 dia concentrados em poucas células.
  const many = Array.from({ length: 4000 }, (_, k) => hotspot(-49.1 + (k % 3) * 0.25, -9.1, k % 2 ? '2026-11-14' : '2026-11-15'))

  it('nenhuma chance, faixa baixa ou alta formata como "100%" ou "0%"', () => {
    for (const horizonDays of [1, 7, 30]) {
      const grid = buildFireGrid(input({ hotspots: many, horizonDays }))
      expect(grid.cells.some((c) => c.p > 0.995)).toBe(true)
      for (const cell of grid.cells) {
        for (const value of [cell.p, cell.pLow, cell.pHigh]) {
          for (const locale of ['pt-BR', 'en'] as const) {
            const shown = formatChance(value, locale)
            expect(shown).not.toMatch(/^100/)
            expect(shown).not.toMatch(/^0([.,]0)?%$/)
          }
        }
      }
    }
    expect(formatChance(1, 'en')).toBe('>99%')
    expect(formatChance(0.9899, 'en')).toBe('99%')
    expect(formatChance(0, 'pt-BR')).toBe('<1%')
    expect(formatChance(MIN_DRAW_P, 'pt-BR')).toBe('1,0%')
  })

  it('janela curta: a faixa é larga (não ±1 ponto), pois soma a variação dia a dia', () => {
    // Janela de ~1,5 dia com 4.000 focos: só o Poisson daria ±3%; com a variação diária, λ alto/baixo > 5.
    const cell = buildFireGrid(input({ hotspots: many, horizonDays: 1 })).cells.find((c) => c.p > 0.001 && c.p < 0.5)!
    expect(cell).toBeDefined()
    const lambda = (p: number) => -Math.log(1 - p)
    expect(lambda(cell.pHigh) / lambda(cell.pLow)).toBeGreaterThan(5)
    // Janela longa e com muitos focos: a faixa estreita, mas nunca abaixo do ruído de Poisson.
    const [low, high] = poissonInterval(4000)
    expect(rateInterval(4000, 60)[0]).toBeLessThanOrEqual(low / 60)
    expect(rateInterval(4000, 60)[1]).toBeGreaterThanOrEqual(high / 60)
    expect(rateInterval(4000, 60)[1] / rateInterval(4000, 1.25)[1]).toBeLessThan(1 / 30)
  })
})

describe('desempenho', () => {
  it('~11k células e 50k focos bem abaixo de 100 ms', () => {
    // Retângulo 26° × 26° ≈ 10,8k células.
    const big: LonLat[] = [[-70, -30], [-44, -30], [-44, -4], [-70, -4]]
    let state = 42
    const rand = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)
    const hotspots = Array.from({ length: 50_000 }, () => hotspot(-72 + rand() * 30, -32 + rand() * 30, rand() < 0.5 ? '2026-11-14' : '2026-11-15'))
    const args = input({ hotspots, regions: [noHistory('big', big)] })
    buildFireGrid(args) // aquece o JIT
    const start = performance.now()
    const grid = buildFireGrid(args)
    const elapsed = performance.now() - start
    expect(grid.cells.length).toBe(104 * 104)
    expect(elapsed).toBeLessThan(100)
    const start2 = performance.now()
    for (let k = 0; k < 10_000; k++) cellAt(grid, hotspots[k].lon, hotspots[k].lat)
    expect(performance.now() - start2).toBeLessThan(100)
  })
})
