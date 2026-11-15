import { LAND_MASK_RUNS } from './land-mask'

// Decodifica as corridas em uma grade plana (true = terra), feita uma vez.
const GRID: Uint8Array = (() => {
  const grid = new Uint8Array(180 * 360)
  LAND_MASK_RUNS.forEach((runs, row) => {
    let col = 0
    runs.forEach((length, i) => {
      if (i % 2 === 1) grid.fill(1, row * 360 + col, row * 360 + col + length)
      col += length
    })
  })
  return grid
})()

// Indica se o ponto (lat, lon), em graus, cai sobre terra.
export function isLandAt(lat: number, lon: number): boolean {
  const row = Math.min(179, Math.max(0, Math.floor(89.5 - lat)))
  const wrapped = ((((lon + 180) % 360) + 360) % 360)
  const col = Math.min(359, Math.max(0, Math.floor(wrapped)))
  return GRID[row * 360 + col] === 1
}
