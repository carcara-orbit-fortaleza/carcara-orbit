import { useEffect, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Hotspot, LonLat, RegionSeries } from '../types'
import type { FilteredCalendar } from '../lib/series'
import { pointInRing, polygonAreaKm2 } from '../lib/geo'
import { formatArea, formatShare } from '../lib/format'

type Props = {
  regions: RegionSeries[]
  hotspots: Hotspot[]
  polygon: LonLat[] | null
  focusRing: LonLat[] | null
  emphasisRegionId: string | null
  calendar: FilteredCalendar
  hotspotsLoading: boolean
  hotspotsError: string | null
  onRetryHotspots: () => void
  onPolygonChange: (polygon: LonLat[] | null) => void
}

const TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'

export function PolygonMap({
  regions,
  hotspots,
  polygon,
  focusRing,
  emphasisRegionId,
  calendar,
  hotspotsLoading,
  hotspotsError,
  onRetryHotspots,
  onPolygonChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const biomeLayerRef = useRef<L.LayerGroup | null>(null)
  const pointLayerRef = useRef<L.LayerGroup | null>(null)
  const shapeLayerRef = useRef<L.LayerGroup | null>(null)
  const draftLayerRef = useRef<L.LayerGroup | null>(null)
  const cursorRef = useRef<L.LatLng | null>(null)
  const drawingRef = useRef(false)
  const draftRef = useRef<LonLat[]>([])
  const redrawDraftRef = useRef<() => void>(() => {})
  const finishRef = useRef<() => void>(() => {})
  const onPolygonChangeRef = useRef(onPolygonChange)
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<LonLat[]>([])

  onPolygonChangeRef.current = onPolygonChange
  drawingRef.current = drawing
  draftRef.current = draft

  finishRef.current = () => {
    if (draftRef.current.length < 3) return
    const ring = draftRef.current.map(([lon, lat]) => [lon, lat] as LonLat)
    setDrawing(false)
    setDraft([])
    cursorRef.current = null
    onPolygonChangeRef.current(ring)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    try {
      const map = L.map(host, { zoomControl: false, attributionControl: true })
      map.setView([-14.5, -54], 4)
      L.tileLayer(TILES, {
        maxZoom: 12,
        minZoom: 3,
        attribution: 'Tiles © Esri — Esri, DeLorme, NAVTEQ · dados NASA FIRMS',
      }).addTo(map)
      L.control.zoom({ position: 'topright' }).addTo(map)
      biomeLayerRef.current = L.layerGroup().addTo(map)
      shapeLayerRef.current = L.layerGroup().addTo(map)
      pointLayerRef.current = L.layerGroup().addTo(map)
      draftLayerRef.current = L.layerGroup().addTo(map)
      mapRef.current = map
      host.setAttribute('aria-label', 'Mapa de focos de calor')

      map.on('mousemove', (event) => {
        cursorRef.current = event.latlng
        if (drawingRef.current) redrawDraftRef.current()
      })
      map.on('click', (event) => {
        if (!drawingRef.current) return
        const nextPoint: LonLat = [event.latlng.lng, event.latlng.lat]
        const current = draftRef.current
        if (current.length >= 3 && pixelDistance(map, current[0], nextPoint) <= 14) {
          finishRef.current()
          return
        }
        if (current.length > 0 && pixelDistance(map, current[current.length - 1], nextPoint) <= 4) return
        const next = [...current, nextPoint]
        draftRef.current = next
        setDraft(next)
      })
      map.on('dblclick', () => {
        if (!drawingRef.current) return
        finishRef.current()
      })

      requestAnimationFrame(() => map.invalidateSize())
      setMapReady(true)

      return () => {
        map.remove()
        mapRef.current = null
        host.replaceChildren()
      }
    } catch {
      setMapError('O mapa não carregou. O calendário continua disponível, sem recorte.')
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (drawing) map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
    map.getContainer().style.cursor = drawing ? 'crosshair' : ''
  }, [drawing, mapReady])

  useEffect(() => {
    if (!drawing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawing(false)
        setDraft([])
        cursorRef.current = null
      } else if (event.key === 'Enter') {
        event.preventDefault()
        finishRef.current()
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        setDraft((current) => current.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing])

  useEffect(() => {
    const layer = biomeLayerRef.current
    if (!layer) return
    layer.clearLayers()
    for (const region of regions) {
      const selected = !polygon && region.id === emphasisRegionId
      L.polygon(toLatLngs(region.ring), {
        color: region.color,
        weight: selected ? 2.2 : 1.2,
        opacity: selected ? 1 : 0.7,
        fillColor: region.color,
        fillOpacity: selected ? 0.1 : 0.03,
        dashArray: selected ? undefined : '5 5',
        interactive: false,
      }).addTo(layer)
    }
  }, [regions, mapReady, emphasisRegionId, polygon])

  useEffect(() => {
    const layer = shapeLayerRef.current
    const map = mapRef.current
    if (!layer || !map) return
    layer.clearLayers()
    if (polygon && polygon.length >= 3) {
      const latlngs = toLatLngs(polygon)
      L.polygon(latlngs, {
        color: '#f2712b',
        weight: 2,
        opacity: 1,
        fillColor: '#f2712b',
        fillOpacity: 0.16,
        interactive: false,
      }).addTo(layer)
    }
    const frame = polygon && polygon.length >= 3 ? polygon : focusRing
    if (frame && frame.length >= 3) {
      map.fitBounds(L.latLngBounds(toLatLngs(frame)), { padding: [28, 28], maxZoom: 6 })
    }
  }, [polygon, focusRing, mapReady])

  useEffect(() => {
    const layer = pointLayerRef.current
    if (!layer) return
    layer.clearLayers()
    const visible = polygon ? hotspots.filter((hotspot) => pointInRing(hotspot.lon, hotspot.lat, polygon)) : hotspots
    for (const hotspot of visible) {
      const modis = hotspot.sensor === 'MODIS'
      const color = modis ? '#f7a03c' : '#6fb3a8'
      const dim = !polygon && emphasisRegionId !== null && hotspot.regionId !== emphasisRegionId
      L.circleMarker([hotspot.lat, hotspot.lon], {
        radius: dim ? 1.7 : 3,
        color,
        weight: 0,
        fillColor: color,
        fillOpacity: dim ? 0.16 : 0.9,
      })
        .bindTooltip(
          `<b>${escapeHtml(hotspot.date)}</b> · ${escapeHtml(hotspot.sensor)} ${escapeHtml(hotspot.platform)}<br>FRP ${hotspot.frp.toLocaleString('pt-BR')} MW · confiança ${hotspot.confidence}`,
          { direction: 'top', className: 'fire-tooltip' },
        )
        .addTo(layer)
    }
  }, [hotspots, polygon, mapReady, emphasisRegionId])

  useEffect(() => {
    const map = mapRef.current
    const layer = draftLayerRef.current
    if (!map || !layer) return
    redrawDraftRef.current = () => {
      layer.clearLayers()
      const current = draftRef.current
      if (!drawingRef.current || current.length === 0) return
      const latlngs = current.map(([lon, lat]) => L.latLng(lat, lon))
      if (cursorRef.current) latlngs.push(cursorRef.current)
      L.polyline(latlngs, {
        color: '#f2712b',
        weight: 2,
        dashArray: '4 4',
        interactive: false,
      }).addTo(layer)
      current.forEach((point, index) => {
        const marker = L.circleMarker([point[1], point[0]], {
          radius: index === 0 ? 7 : 4.5,
          color: '#f2efe8',
          weight: 2,
          fillColor: index === 0 ? '#f2712b' : '#1a1f25',
          fillOpacity: 1,
          interactive: index === 0 && current.length >= 3,
        })
        if (index === 0 && current.length >= 3) {
          marker.on('click', (event: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(event.originalEvent)
            finishRef.current()
          })
        }
        marker.addTo(layer)
      })
    }
    redrawDraftRef.current()
  }, [draft, drawing, mapReady])

  const inside = polygon ? hotspots.filter((hotspot) => pointInRing(hotspot.lon, hotspot.lat, polygon)) : hotspots
  const area = polygon ? polygonAreaKm2(polygon) : null
  const activeWeights = calendar.weights.filter((weight) => weight.weight > 0 && calendar.mode === 'polygon')

  function beginDrawing() {
    if (drawing) {
      setDrawing(false)
      setDraft([])
      cursorRef.current = null
      return
    }
    setDraft([])
    setDrawing(true)
  }

  function clearPolygon() {
    setDrawing(false)
    setDraft([])
    cursorRef.current = null
    onPolygonChange(null)
  }

  const status = statusText({
    drawing,
    vertices: draft.length,
    polygon,
    inside: inside.length,
    total: hotspots.length,
    area,
    empty: calendar.mode === 'empty',
    hotspotsLoading,
    hotspotsError,
  })

  return (
    <article className="card map-card" id="mapa">
      <header className="card-head">
        <div>
          <h2 id="map-title">Focos recentes</h2>
          <p>2024—2026 · o polígono desenhado filtra focos e calendário</p>
        </div>
        <div className="map-legend">
          <span><i className="sensor-dot modis" />MODIS</span>
          <span><i className="sensor-dot viirs" />VIIRS</span>
        </div>
      </header>
      <div className="draw-bar">
        <button type="button" className="btn primary" aria-pressed={drawing} onClick={beginDrawing}>
          {drawing ? 'Cancelar desenho' : 'Desenhar polígono'}
        </button>
        <button type="button" className="btn" disabled={!drawing || draft.length === 0} onClick={() => setDraft((current) => current.slice(0, -1))}>
          Desfazer ponto
        </button>
        <button type="button" className="btn" disabled={draft.length < 3} onClick={() => finishRef.current()}>
          Fechar polígono
        </button>
        <button type="button" className="btn ghost" disabled={!polygon && !drawing && draft.length === 0} onClick={clearPolygon}>
          Limpar recorte
        </button>
      </div>
      {mapError ? (
        <div className="map-fallback" role="status">{mapError}</div>
      ) : (
        <div className="map-frame">
          <div ref={hostRef} className="map" />
          <p className="map-hint">
            {drawing
              ? 'Clique para marcar vértices. Feche no primeiro ponto.'
              : polygon
                ? 'Polígono ativo. Os focos de fora ficam de fora do recorte.'
                : 'A célula selecionada está em destaque. As demais ficam tracejadas.'}
          </p>
        </div>
      )}
      <p className="status" id="filter-status" aria-live="polite">{status}</p>
      {hotspotsError && (
        <p className="map-data-error" role="status">
          <span>O mapa de focos falhou. O calendário segue disponível.</span>
          <button className="mini-btn" type="button" onClick={onRetryHotspots}>Tentar de novo</button>
        </p>
      )}
      {calendar.mode === 'polygon' && (
        <ul className="weight-inline">
          {activeWeights
            .slice()
            .sort((a, b) => b.weight - a.weight)
            .map((weight) => (
              <li key={weight.id}><i style={{ background: weight.color }} />{weight.name} {formatShare(weight.weight)}</li>
            ))}
        </ul>
      )}
    </article>
  )
}

function statusText(input: {
  drawing: boolean
  vertices: number
  polygon: LonLat[] | null
  inside: number
  total: number
  area: number | null
  empty: boolean
  hotspotsLoading: boolean
  hotspotsError: string | null
}): string {
  if (input.hotspotsLoading) return 'Carregando focos globais…'
  if (input.hotspotsError) return input.hotspotsError
  if (input.drawing) {
    return input.vertices < 3
      ? `Desenho em andamento, ${input.vertices} ${input.vertices === 1 ? 'vértice' : 'vértices'}. Marque pelo menos três.`
      : `Desenho em andamento, ${input.vertices} vértices. Feche no primeiro ponto ou em Fechar polígono.`
  }
  if (input.empty) return 'O polígono não cruza as células da série. O calendário fica sem dado nesse recorte.'
  if (input.polygon && input.area !== null) {
    return `${input.inside.toLocaleString('pt-BR')} de ${input.total.toLocaleString('pt-BR')} focos dentro do polígono · ${formatArea(input.area)}.`
  }
  return `Sem recorte livre. ${input.total.toLocaleString('pt-BR')} focos na amostra; a célula escolhida segue em destaque.`
}

function toLatLngs(ring: LonLat[]): L.LatLngExpression[] {
  return ring.map(([lon, lat]) => [lat, lon])
}

function pixelDistance(map: L.Map, a: LonLat, b: LonLat): number {
  const from = map.latLngToContainerPoint([a[1], a[0]])
  const to = map.latLngToContainerPoint([b[1], b[0]])
  return Math.hypot(from.x - to.x, from.y - to.y)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char] ?? char
  })
}
