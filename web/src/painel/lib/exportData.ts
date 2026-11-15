import type { FilteredCalendar } from './series'
import type { FireGrid } from './fireGrid'
import type { Hotspot, LonLat, RegionSeries } from '../types'

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    link.remove()
  }, 400)
}

/** Versões gravadas em cada linha exportada, lidas de /api/meta. */
export type ExportVersions = { method: string; dataset: string }

export function calendarCsv(calendar: FilteredCalendar, years: number[], place: string, biome: string, versions: ExportVersions): string {
  const header = ['regiao', 'bioma', 'ano', 'mes', 'focos_harmonizados', 'anomalia_pct', 'modis_bruto', 'viirs_bruto', 'metodo', 'versao']
  const rows = [header]
  years.forEach((year, yearIndex) => {
    for (let month = 0; month < 12; month++) {
      const count = calendar.counts[yearIndex]?.[month]
      if (count === null || count === undefined) continue
      rows.push([
        place,
        biome,
        String(year),
        MONTHS[month],
        num(count, count < 10 ? 1 : 0),
        num(calendar.anomaly[yearIndex]?.[month] ?? null, 1),
        num(calendar.rawModis[yearIndex]?.[month] ?? null, 0),
        num(calendar.rawViirs[yearIndex]?.[month] ?? null, 0),
        versions.method,
        versions.dataset,
      ])
    }
  })
  return `\uFEFF${rows.map((row) => row.join(';')).join('\r\n')}`
}

export function hotspotCsv(hotspots: Hotspot[], versions: ExportVersions): string {
  const header = ['id', 'data', 'lat', 'lon', 'sensor', 'plataforma', 'frp_mw', 'confianca', 'regiao', 'versao']
  const rows = [header, ...hotspots.map((hotspot) => [
    hotspot.id,
    hotspot.date,
    num(hotspot.lat, 5),
    num(hotspot.lon, 5),
    hotspot.sensor,
    hotspot.platform,
    num(hotspot.frp, 1),
    hotspot.confidence === null ? '' : String(hotspot.confidence),
    hotspot.regionId,
    versions.method,
  ])]
  return `\uFEFF${rows.map((row) => row.join(';')).join('\r\n')}`
}

/**
 * Grade de chance por célula. Cada linha é uma hipótese (padrão recente se repete), não previsão:
 * a confiança e as ressalvas da grade vão em todas as linhas para não se perderem fora do painel.
 */
export function gridCsv(grid: FireGrid, regions: RegionSeries[], versions: ExportVersions): string {
  const names = new Map(regions.map((region) => [region.id, region.name]))
  const header = ['id', 'lon_centro', 'lat_centro', 'regiao', 'observados', 'esperados', 'p', 'p05', 'p95', 'horizonte_dias', 'confianca', 'ressalvas', 'versao']
  const caveats = grid.caveats.join('|')
  const rows = [header, ...grid.cells.map((cell) => [
    cell.id,
    num(cell.center[0], 3),
    num(cell.center[1], 3),
    names.get(cell.regionId) ?? cell.regionId,
    String(cell.observed),
    num(cell.expected, 4),
    num(cell.p, 4),
    num(cell.pLow, 4),
    num(cell.pHigh, 4),
    String(grid.horizonDays),
    grid.confidence,
    caveats,
    versions.method,
  ])]
  return `\uFEFF${rows.map((row) => row.join(';')).join('\r\n')}`
}

export function areaGeoJson(ring: LonLat[], name: string, versions: ExportVersions): string {
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring
    : [...ring, ring[0]]
  return JSON.stringify({
    type: 'Feature',
    properties: { name, method_version: versions.method, dataset_version: versions.dataset },
    geometry: { type: 'Polygon', coordinates: [closed] },
  }, null, 2)
}

function num(value: number | null, digits: number): string {
  if (value === null || Number.isNaN(value)) return ''
  return value.toFixed(digits).replace('.', ',')
}
