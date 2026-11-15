import type { FilteredCalendar } from './series'
import type { Hotspot, LonLat } from '../types'

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

export function calendarCsv(calendar: FilteredCalendar, years: number[], place: string, biome: string): string {
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
        'h1.0-mock',
        'mock-1.0',
      ])
    }
  })
  return `\uFEFF${rows.map((row) => row.join(';')).join('\r\n')}`
}

export function hotspotCsv(hotspots: Hotspot[]): string {
  const header = ['id', 'data', 'lat', 'lon', 'sensor', 'plataforma', 'frp_mw', 'confianca', 'regiao', 'versao']
  const rows = [header, ...hotspots.map((hotspot) => [
    hotspot.id,
    hotspot.date,
    num(hotspot.lat, 5),
    num(hotspot.lon, 5),
    hotspot.sensor,
    hotspot.platform,
    num(hotspot.frp, 1),
    String(hotspot.confidence),
    hotspot.regionId,
    'h1.0-mock',
  ])]
  return `\uFEFF${rows.map((row) => row.join(';')).join('\r\n')}`
}

export function areaGeoJson(ring: LonLat[], name: string): string {
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring
    : [...ring, ring[0]]
  return JSON.stringify({
    type: 'Feature',
    properties: { name, method_version: 'h1.0-mock' },
    geometry: { type: 'Polygon', coordinates: [closed] },
  }, null, 2)
}

function num(value: number | null, digits: number): string {
  if (value === null || Number.isNaN(value)) return ''
  return value.toFixed(digits).replace('.', ',')
}
