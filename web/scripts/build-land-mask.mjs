// Gera src/data/land-mask.ts a partir dos contornos do Natural Earth (ne_110m_land, domínio público).
// Uso: node scripts/build-land-mask.mjs <caminho para ne_110m_land.geojson>
// Grade de 1°: uma linha por latitude (do norte ao sul), uma coluna por longitude (de oeste a leste).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const input = process.argv[2]
if (!input) {
  console.error('Uso: node scripts/build-land-mask.mjs <ne_110m_land.geojson>')
  process.exit(1)
}
const output = resolve(here, '../src/data/land-mask.ts')

const geo = JSON.parse(readFileSync(input, 'utf8'))
const polygons = []
for (const feature of geo.features) {
  const g = feature.geometry
  if (g.type === 'Polygon') polygons.push(g.coordinates)
  else if (g.type === 'MultiPolygon') polygons.push(...g.coordinates)
}

// Ray casting: ponto (lon, lat) dentro de um anel de coordenadas [lon, lat].
function inRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function isLand(lon, lat) {
  for (const poly of polygons) {
    if (!inRing(lon, lat, poly[0])) continue
    // Buracos (lagos, por exemplo) não contam como terra.
    let inHole = false
    for (let k = 1; k < poly.length; k++) {
      if (inRing(lon, lat, poly[k])) {
        inHole = true
        break
      }
    }
    if (!inHole) return true
  }
  return false
}

const ROWS = 180
const COLS = 360
const rows = []
for (let r = 0; r < ROWS; r++) {
  const lat = 89.5 - r
  // Corridas alternadas, começando por água: [água, terra, água, ...].
  const runs = []
  let current = false
  let length = 0
  for (let c = 0; c < COLS; c++) {
    const lon = -179.5 + c
    const land = isLand(lon, lat)
    if (land === current) {
      length++
    } else {
      runs.push(length)
      current = land
      length = 1
    }
  }
  runs.push(length)
  rows.push(runs)
}

const body = rows.map((runs) => `  [${runs.join(', ')}],`).join('\n')
const file = `// Arquivo gerado por scripts/build-land-mask.mjs. Não editar à mão.
// Fonte: Natural Earth 110m, land (domínio público). Grade de 1°.
// Cada linha é uma latitude (de 89,5° a -89,5°); cada número é uma corrida de colunas,
// alternando água e terra, começando por água. As colunas vão de -179,5° a 179,5°.
export const LAND_MASK_RUNS: readonly (readonly number[])[] = [
${body}
]
`

writeFileSync(output, file)
const landCells = rows.reduce((sum, runs) => sum + runs.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0), 0)
console.log(`Máscara gravada em ${output}. Células de terra: ${landCells} de ${ROWS * COLS}.`)
