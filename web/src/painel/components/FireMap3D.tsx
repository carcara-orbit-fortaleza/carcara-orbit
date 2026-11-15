import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import type { FilterSpecification, GeoJSONSource, LngLatBoundsLike, MapMouseEvent, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { Hotspot, LonLat, RegionSeries } from '../types'
import type { FilteredCalendar } from '../lib/series'
import { CELL_DEG, GRID_HORIZONS, MIN_DRAW_P, type FireCell, type FireGrid } from '../lib/fireGrid'
import { pointInRing, polygonAreaKm2 } from '../lib/geo'
import { formatArea, formatChance, formatCount, formatShare } from '../lib/format'
import { levelLabel, usePanelText, type PanelText } from '../lib/panelText'
// Só o tipo: o módulo (e o three.js, ~130 kB gzip) vem por import() depois do 'load' do mapa.
import type { FireFlameLayer } from './fireFlameLayer'
import type { MessageKey } from '../../i18n/messages'
import './FireMap3D.css'

export type FireMap3DProps = {
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
  /** Ex.: "2024–2026", a janela de focos pedida à API. */
  hotspotWindowLabel: string
  /** Grade de chance por célula; null enquanto não há grade. */
  grid: FireGrid | null
  gridLoading?: boolean
  /** Horizonte em dias (um de GRID_HORIZONS). */
  horizonDays: number
  onHorizonChange: (days: number) => void
  selectedCellId: string | null
  onCellSelect: (cell: FireCell | null) => void
}

// Câmera 3D fixa: inclinação e rumo travados, só pan e zoom.
const PITCH = 55
const BEARING = -12
const START_CENTER: [number, number] = [-54, -14.5]
const START_ZOOM = 3.6
/**
 * fitBounds do MapLibre enquadra como se o mapa fosse plano: com a inclinação, a borda de perto
 * (sul) aumenta ~1,3× e sai da tela. Afasta o zoom por log2(1,4) para caber a caixa inteira.
 */
const PITCH_FIT_ZOOM_OUT = Math.log2(1.4)
const FIT_PADDING = 36
const FIT_MAX_ZOOM = 6
/**
 * Enquadramento "pesado embaixo": depois de caber o anel, desce o centro esta fração da altura da
 * tela e aproxima um pouco. Com a inclinação, o topo da tela é o horizonte distante (oceano, Caribe);
 * assim o anel ocupa a parte de cima e o chão perto da câmera mostra o fogo ao sul (Cerrado).
 */
const FIT_SOUTH_BIAS = 0.25
const FIT_ZOOM_IN = 0.35
/** Pulso do último dia: ~12 quadros/s e para sozinho depois disto (cada quadro redesenha a cena 3D). */
const PULSE_FRAME_MS = 80
const PULSE_MAX_MS = 30_000
/** Anel do pulso contido (px): não pode ofuscar o brilho e as chamas embaixo. */
const PULSE_MAX_RADIUS = 10
const PULSE_REST_RADIUS = 5
const PULSE_REST_OPACITY = 0.3
/** Abaixo deste zoom os focos esmaecidos (fora do bioma em foco) não aparecem nem respondem ao hover. */
const DIM_DOTS_ZOOM = 4.5
/** A partir deste zoom os focos ganham contorno escuro e opacidade cheia. */
const DOTS_SOLID_ZOOM = 6
/** Expressão de estilo do MapLibre (o tipo não é reexportado pelo pacote). */
type Expression = Exclude<Extract<FilterSpecification, ['!', unknown]>[1], boolean>

const EMBER = '#f2712b'
const MODIS = '#f7a03c'
// VIIRS em ciano pálido (não o teal do painel): o frio saturado brigava com a paleta quente do fogo.
const VIIRS = '#9fd8d0'

const GLOW_TOP = '#fff1b8'
// Brilho no chão (heatmap dos centros das células): invisível até 0,25 de densidade (chance baixa
// some, sem tapete e sem "buracos"), vermelho fundo → laranja na faixa média e âmbar/amarelo pálido
// só acima de 0,85: os núcleos mais quentes se destacam da faixa contínua em vez de virar uma fita
// laranja chapada. A legenda (.fire-chance-bar) segue a mesma rampa, com rótulos qualitativos
// (menor → maior): a cor soma vizinhas, então não se lê como a chance de uma célula.
const GLOW_COLOR: Expression = [
  'interpolate', ['linear'], ['heatmap-density'],
  0, 'rgba(120,20,10,0)',
  0.25, 'rgba(120,20,10,0)',
  0.4, 'rgba(160,34,14,0.38)',
  0.6, 'rgba(204,62,22,0.58)',
  0.78, 'rgba(232,98,30,0.78)',
  0.85, '#f07a22',
  0.93, '#ffb347',
  1, GLOW_TOP,
] as unknown as Expression

const CAVEAT_KEYS: Record<string, MessageKey> = {
  'short-window': 'fireMapCaveatShortWindow',
  'no-seasonality': 'fireMapCaveatNoSeasonality',
  'no-hotspots': 'fireMapCaveatNoHotspots',
  'incomplete-feed': 'fireMapCaveatIncompleteFeed',
  'not-calibrated': 'fireMapCaveatNotCalibrated',
}

const HORIZON_KEYS: Record<number, MessageKey> = {
  1: 'fireMapHorizon1',
  7: 'fireMapHorizon7',
  30: 'fireMapHorizon30',
}


const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
/** Id da camada custom de chamas (o mesmo de createFireFlameLayer). */
const FLAME_LAYER_ID = 'fire-flames'
/** As chamas ficam logo abaixo dos focos observados. */
const FLAME_BEFORE_ID = 'hotspots-dots'

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    imagery: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics · NASA FIRMS',
    },
    // Fontes DEM separadas para relevo e sombreamento, como a documentação do MapLibre recomenda.
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: 'Elevation: Mapzen/AWS Terrain Tiles',
    },
    'dem-shade': {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
    },
  },
  terrain: { source: 'dem', exaggeration: 1.5 },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b0d10' } },
    {
      id: 'imagery',
      type: 'raster',
      source: 'imagery',
      // Escurece e dessatura a imagem para as cores de fogo saltarem.
      paint: {
        'raster-brightness-max': 0.52,
        'raster-saturation': -0.45,
        'raster-contrast': 0.08,
      },
    },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-shade',
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#05070a',
        'hillshade-highlight-color': '#3a3f47',
        'hillshade-accent-color': '#14181d',
      },
    },
  ],
}

export function FireMap3D({
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
  hotspotWindowLabel,
  grid,
  gridLoading = false,
  horizonDays,
  onHorizonChange,
  selectedCellId,
  onCellSelect,
}: FireMap3DProps) {
  const text = usePanelText()
  const { t, locale } = text
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)
  const flameRef = useRef<FireFlameLayer | null>(null)
  const cursorRef = useRef<LonLat | null>(null)
  const drawingRef = useRef(false)
  const draftRef = useRef<LonLat[]>([])
  const hoverCellRef = useRef<string | null>(null)
  const redrawDraftRef = useRef<() => void>(() => {})
  const finishRef = useRef<() => void>(() => {})
  const onPolygonChangeRef = useRef(onPolygonChange)
  const onCellSelectRef = useRef(onCellSelect)
  const cellByIdRef = useRef<Map<string, FireCell>>(new Map())
  const textRef = useRef<PanelText>(text)
  const horizonRef = useRef(horizonDays)
  const [styleReady, setStyleReady] = useState(false)
  const [mapError, setMapError] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [draft, setDraft] = useState<LonLat[]>([])
  const reducedMotion = usePrefersReducedMotion()
  const reducedMotionRef = useRef(reducedMotion)
  // Estado que a camada de chamas precisa ao nascer: ela chega depois (import assíncrono) e é
  // recriada após perda do contexto WebGL.
  const drawnCellsRef = useRef<readonly FireCell[]>([])
  const onScreenRef = useRef(true)

  onPolygonChangeRef.current = onPolygonChange
  onCellSelectRef.current = onCellSelect
  drawingRef.current = drawing
  draftRef.current = draft
  textRef.current = text
  horizonRef.current = horizonDays
  reducedMotionRef.current = reducedMotion

  const cellById = useMemo(() => {
    const index = new Map<string, FireCell>()
    for (const cell of grid?.cells ?? []) index.set(cell.id, cell)
    return index
  }, [grid])
  cellByIdRef.current = cellById

  const visible = useMemo(
    () => (polygon ? hotspots.filter((hotspot) => pointInRing(hotspot.lon, hotspot.lat, polygon)) : hotspots),
    [hotspots, polygon],
  )

  // Último dia com foco: o da grade quando existe, senão o mais recente da amostra.
  const latestDay = useMemo(() => {
    if (grid?.windowTo) return grid.windowTo
    let latest: string | null = null
    for (const hotspot of hotspots) if (latest === null || hotspot.date > latest) latest = hotspot.date
    return latest
  }, [grid, hotspots])

  finishRef.current = () => {
    if (draftRef.current.length < 3) return
    const ring = draftRef.current.map(([lon, lat]) => [lon, lat] as LonLat)
    setDrawing(false)
    setDraft([])
    cursorRef.current = null
    onPolygonChangeRef.current(ring)
  }

  // Cria o mapa uma única vez. Mudanças de props entram pelos efeitos abaixo, via setData.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!webglAvailable()) {
      setMapError(true)
      return
    }
    let map: maplibregl.Map
    try {
      map = new maplibregl.Map({
        container: host,
        style: STYLE,
        center: START_CENTER,
        zoom: START_ZOOM,
        minZoom: 2.5,
        maxZoom: 12,
        pitch: PITCH,
        bearing: BEARING,
        minPitch: PITCH,
        maxPitch: PITCH,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        rollEnabled: false,
        attributionControl: { compact: true },
        fadeDuration: 0,
      })
    } catch {
      setMapError(true)
      return
    }
    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right')
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'fire-popup', maxWidth: '280px', offset: 10 })
    popupRef.current = popup

    let loaded = false
    let disposed = false
    // O ResizeObserver é criado mais abaixo; o erro chega sempre depois (evento assíncrono).
    let observer: ResizeObserver | null = null
    // Uma camada de chamas por mapa (e por contexto WebGL): no StrictMode cada montagem cria e libera
    // a sua; depois de perder o contexto o MapLibre restaura o estilo sem camadas custom.
    let flames: FireFlameLayer | null = null
    const dropFlames = () => {
      flames?.dispose()
      flames = null
      flameRef.current = null
    }
    const mountFlames = () => {
      if (disposed || flames || !hasLayer(map, FLAME_BEFORE_ID)) return
      import('./fireFlameLayer')
        .then(({ createFireFlameLayer }) => {
          if (disposed || flames || !hasLayer(map, FLAME_BEFORE_ID) || hasLayer(map, FLAME_LAYER_ID)) return
          const layer = createFireFlameLayer({ reducedMotion: reducedMotionRef.current })
          try {
            map.addLayer(layer, FLAME_BEFORE_ID)
          } catch (error) {
            // Chamas são enfeite sobre o brilho: sem elas o mapa segue com tudo o mais.
            layer.dispose()
            if (import.meta.env.DEV) console.warn('[fire-flames] camada não adicionada', error)
            return
          }
          flames = layer
          flameRef.current = layer
          layer.setVisible(onScreenRef.current)
          layer.setCells(drawnCellsRef.current)
        })
        .catch((error: unknown) => {
          if (import.meta.env.DEV) console.warn('[fire-flames] módulo não carregou', error)
        })
    }
    const dispose = () => {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      popup.remove()
      popupRef.current = null
      dropFlames()
      map.remove()
      mapRef.current = null
      hoverCellRef.current = null
    }
    map.on('error', (event) => {
      // Falha de tile isolada não derruba o mapa; só falha antes do estilo carregar. Nesse caso o
      // mapa é destruído já (contexto WebGL, workers, ouvintes), pois o quadro some da tela.
      const sourceId = (event as { sourceId?: string }).sourceId
      if (loaded || sourceId || disposed) return
      dispose()
      setMapError(true)
    })

    map.on('load', () => {
      loaded = true
      try {
        map.setSky({
          'sky-color': '#0a0e15',
          'horizon-color': '#2b211d',
          'fog-color': '#121014',
          'sky-horizon-blend': 0.55,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.35,
          'atmosphere-blend': 0,
        })
      } catch {
        // Céu é enfeite; sem suporte, o mapa segue sem ele.
      }
      addOverlayLayers(map)
      setStyleReady(true)
      mountFlames()
    })

    // Perda do contexto WebGL (reset da GPU, aba descartada, celular em segundo plano): o MapLibre
    // guarda o estilo sem a camada custom. Libera a antiga e recria quando o estilo voltar.
    map.on('webglcontextlost', () => {
      dropFlames()
      hoverCellRef.current = null
      popup.remove()
    })
    map.on('webglcontextrestored', () => {
      hoverCellRef.current = null
      if (map.isStyleLoaded()) mountFlames()
      else map.once('style.load', mountFlames)
    })

    const setHoverCell = (id: string | null) => {
      if (hoverCellRef.current === id) return
      if (hoverCellRef.current !== null) map.setFeatureState({ source: 'cells-glow', id: hoverCellRef.current }, { hover: false })
      hoverCellRef.current = id
      if (id !== null) map.setFeatureState({ source: 'cells-glow', id }, { hover: true })
    }

    map.on('mousemove', (event) => {
      cursorRef.current = [event.lngLat.lng, event.lngLat.lat]
      const canvas = map.getCanvas()
      if (drawingRef.current) {
        redrawDraftRef.current()
        popup.remove()
        setHoverCell(null)
        canvas.style.cursor = 'crosshair'
        return
      }
      if (!loaded) return
      const hit = map.queryRenderedFeatures(event.point, { layers: ['hotspots-dots', 'cells-hit'] })
      const dot = hit.find(
        (feature) => feature.layer.id === 'hotspots-dots' && !(feature.properties?.dim === true && map.getZoom() < DIM_DOTS_ZOOM),
      )
      const cellFeature = hit.find((feature) => feature.layer.id === 'cells-hit')
      const current = textRef.current
      if (dot) {
        // Os dados do popup vêm do próprio feature: enquanto o setData é processado no worker, os
        // tiles antigos continuam respondendo e um índice num array novo apontaria outro foco.
        const hotspot = hotspotFromProperties(dot.properties)
        if (hotspot) {
          popup.setLngLat([hotspot.lon, hotspot.lat]).setHTML(hotspotHtml(hotspot, current)).addTo(map)
          canvas.style.cursor = 'pointer'
          setHoverCell(null)
          return
        }
      }
      // A chama em pé cobre na tela o chão de outras células: ela vale antes do quadrado embaixo.
      const cellId = flameRef.current?.pick(event.point) ?? (cellFeature ? String(cellFeature.properties?.id) : null)
      const cell = cellId !== null ? cellByIdRef.current.get(cellId) : undefined
      if (cell) {
        popup.setLngLat(event.lngLat).setHTML(cellHtml(cell, horizonRef.current, current)).addTo(map)
        canvas.style.cursor = 'pointer'
        setHoverCell(cell.id)
        return
      }
      popup.remove()
      setHoverCell(null)
      canvas.style.cursor = ''
    })
    map.on('mouseout', () => {
      popup.remove()
      if (loaded) setHoverCell(null)
    })

    map.on('click', (event: MapMouseEvent) => {
      if (drawingRef.current) {
        const nextPoint: LonLat = [event.lngLat.lng, event.lngLat.lat]
        const current = draftRef.current
        if (current.length >= 3 && pixelDistance(map, current[0], nextPoint) <= 14) {
          finishRef.current()
          return
        }
        if (current.length > 0 && pixelDistance(map, current[current.length - 1], nextPoint) <= 4) return
        const next = [...current, nextPoint]
        draftRef.current = next
        setDraft(next)
        return
      }
      if (!loaded) return
      const flameCellId = flameRef.current?.pick(event.point) ?? null
      const hit = flameCellId === null ? map.queryRenderedFeatures(event.point, { layers: ['cells-hit'] }) : []
      const cellId = flameCellId ?? (hit.length > 0 ? String(hit[0].properties?.id) : null)
      const cell = cellId !== null ? cellByIdRef.current.get(cellId) : undefined
      onCellSelectRef.current(cell ?? null)
    })
    map.on('dblclick', () => {
      if (!drawingRef.current) return
      finishRef.current()
    })

    // O cartão muda de largura sem resize da janela (grade responsiva).
    observer = new ResizeObserver(() => map.resize())
    observer.observe(host)

    return () => {
      dispose()
      setStyleReady(false)
    }
  }, [])

  useEffect(() => {
    hostRef.current?.setAttribute('aria-label', t('panelMapAria'))
  }, [t, styleReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (drawing) map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
    map.getCanvas().style.cursor = drawing ? 'crosshair' : ''
    if (drawing) popupRef.current?.remove()
  }, [drawing, styleReady])

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

  // Contornos dos biomas: selecionado sólido, demais tracejados.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const features: Feature[] = regions
      .filter((region) => region.ring.length >= 3)
      .map((region) => ({
        type: 'Feature',
        properties: { color: region.color, selected: !polygon && region.id === emphasisRegionId },
        geometry: { type: 'Polygon', coordinates: [closedRing(region.ring)] },
      }))
    setSourceData(map, 'biomes', { type: 'FeatureCollection', features })
  }, [regions, emphasisRegionId, polygon, styleReady])

  // Polígono desenhado e enquadramento (mantém a câmera inclinada).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const hasPolygon = polygon !== null && polygon.length >= 3
    setSourceData(
      map,
      'polygon',
      hasPolygon
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closedRing(polygon)] } }] }
        : EMPTY,
    )
    const frame = hasPolygon ? polygon : focusRing
    if (frame && frame.length >= 3) {
      const camera = pitchedCamera(map, frame)
      if (camera) {
        map.easeTo({
          ...camera,
          pitch: PITCH,
          bearing: BEARING,
          duration: reducedMotionRef.current ? 0 : 900,
        })
      }
    }
  }, [polygon, focusRing, styleReady])

  // Focos recentes: pontos, brilho em zoom baixo e marcação do último dia.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const features: Feature[] = visible.map((hotspot) => ({
      type: 'Feature',
      properties: {
        ...hotspotProperties(hotspot),
        modis: hotspot.sensor === 'MODIS',
        dim: !polygon && emphasisRegionId !== null && hotspot.regionId !== emphasisRegionId,
        latest: latestDay !== null && hotspot.date === latestDay,
      },
      geometry: { type: 'Point', coordinates: [hotspot.lon, hotspot.lat] },
    }))
    setSourceData(map, 'hotspots', { type: 'FeatureCollection', features })
    popupRef.current?.remove()
  }, [visible, polygon, emphasisRegionId, latestDay, styleReady])

  // Chance por célula: brilho no chão (centros), chamas 3D e quadrados invisíveis só para o clique.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const drawn = (grid?.cells ?? []).filter((cell) => cell.p >= MIN_DRAW_P)
    const features: Feature[] = drawn.map((cell) => ({
      type: 'Feature',
      properties: { id: cell.id, p: cell.p },
      geometry: cellPolygon(cell),
    }))
    const glow: Feature[] = drawn.map((cell) => ({
      type: 'Feature',
      properties: { id: cell.id, p: cell.p, expected: cell.expected },
      geometry: { type: 'Point', coordinates: cell.center },
    }))
    // O feature-state sobrevive ao setData (ids estáveis): limpa o hover antes, senão o contorno
    // fica aceso e o popup segue com a chance do horizonte anterior.
    map.removeFeatureState({ source: 'cells-glow' })
    hoverCellRef.current = null
    popupRef.current?.remove()
    setSourceData(map, 'cells', { type: 'FeatureCollection', features })
    setSourceData(map, 'cells-glow', { type: 'FeatureCollection', features: glow })
    drawnCellsRef.current = drawn
    flameRef.current?.setCells(drawn)
  }, [grid, styleReady])

  // Célula selecionada: anel brilhante no chão e ponto no centro (sem caixa: não é perímetro).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    const cell = selectedCellId ? cellById.get(selectedCellId) : undefined
    setSourceData(
      map,
      'selected-cell',
      cell
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: { kind: 'ring' }, geometry: cellRing(cell) },
              { type: 'Feature', properties: { kind: 'center' }, geometry: { type: 'Point', coordinates: cell.center } },
            ],
          }
        : EMPTY,
    )
  }, [selectedCellId, cellById, styleReady])

  // Rascunho do polígono em fontes GeoJSON (linha tracejada seguindo o cursor + vértices).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady) return
    redrawDraftRef.current = () => {
      const current = draftRef.current
      if (!drawingRef.current || current.length === 0) {
        setSourceData(map, 'draft', EMPTY)
        return
      }
      const line: LonLat[] = [...current]
      if (cursorRef.current) line.push(cursorRef.current)
      const features: Feature[] = []
      if (line.length >= 2) {
        features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: line } })
      }
      current.forEach((point, index) => {
        features.push({
          type: 'Feature',
          properties: { kind: 'vertex', first: index === 0, closable: index === 0 && current.length >= 3 },
          geometry: { type: 'Point', coordinates: point },
        })
      })
      setSourceData(map, 'draft', { type: 'FeatureCollection', features })
    }
    redrawDraftRef.current()
  }, [draft, drawing, styleReady])

  // Chamas: animam só com o mapa na tela e a aba visível; com prefers-reduced-motion, quadro parado.
  // Vale para a camada atual (pode chegar depois ou ser recriada): o estado fica nas refs.
  useEffect(() => {
    flameRef.current?.setReducedMotion(reducedMotion)
  }, [styleReady, reducedMotion])
  useEffect(() => {
    const host = hostRef.current
    if (!host || !styleReady) return
    return watchOnScreen(host, (onScreen) => {
      onScreenRef.current = onScreen
      flameRef.current?.setVisible(onScreen)
    })
  }, [styleReady])

  // Pulso dos focos do último dia. Sem animação com prefers-reduced-motion.
  const hasLatest = useMemo(() => latestDay !== null && visible.some((hotspot) => hotspot.date === latestDay), [visible, latestDay])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReady || !map.getLayer('hotspots-pulse')) return
    if (!hasLatest || reducedMotion) {
      map.setPaintProperty('hotspots-pulse', 'circle-radius', PULSE_REST_RADIUS)
      map.setPaintProperty('hotspots-pulse', 'circle-stroke-opacity', hasLatest ? PULSE_REST_OPACITY : 0)
      return
    }
    // Cada setPaintProperty redesenha a cena inteira (relevo, colunas, heatmap): anima só com o
    // mapa na tela e a aba visível, em ~12 quadros/s, e para sozinho depois de PULSE_MAX_MS.
    const host = hostRef.current
    let frame = 0
    let last = 0
    let started: number | null = null
    let inView = true
    const period = 1700
    const rest = () => {
      map.setPaintProperty('hotspots-pulse', 'circle-radius', PULSE_REST_RADIUS)
      map.setPaintProperty('hotspots-pulse', 'circle-stroke-opacity', PULSE_REST_OPACITY)
    }
    const tick = (now: number) => {
      frame = 0
      if (started === null) started = now
      if (now - started > PULSE_MAX_MS) {
        rest()
        return
      }
      schedule()
      if (now - last < PULSE_FRAME_MS) return
      last = now
      const phase = (now % period) / period
      map.setPaintProperty('hotspots-pulse', 'circle-radius', 3 + phase * (PULSE_MAX_RADIUS - 3))
      map.setPaintProperty('hotspots-pulse', 'circle-stroke-opacity', 0.5 * (1 - phase))
    }
    function schedule() {
      if (frame !== 0 || !inView || document.hidden) return
      frame = requestAnimationFrame(tick)
    }
    const pause = () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
    }
    const unwatch = host
      ? watchOnScreen(host, (onScreen) => {
          inView = onScreen
          if (onScreen) schedule()
          else pause()
        })
      : null
    schedule()
    return () => {
      pause()
      unwatch?.()
    }
  }, [styleReady, hasLatest, reducedMotion, visible])

  const area = polygon ? polygonAreaKm2(polygon) : null
  const activeWeights = calendar.weights.filter((weight) => weight.weight > 0 && calendar.mode === 'polygon')
  const selectedCell = selectedCellId ? cellById.get(selectedCellId) ?? null : null
  const daysLabel = horizonLabel(horizonDays, text)
  const caveats = (grid?.caveats ?? [])
    .map((key) => CAVEAT_KEYS[key])
    .filter((key): key is MessageKey => key !== undefined)

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
    inside: visible.length,
    total: hotspots.length,
    area,
    empty: calendar.mode === 'empty',
    hotspotsLoading,
    hotspotsError,
  }, text)

  return (
    <article className="card map-card fire-map-3d" id="map">
      <header className="card-head">
        <div>
          <h2 id="map-title">{t('fireMapTitle')}</h2>
          <p>{t('fireMapSub', { window: hotspotWindowLabel })}</p>
        </div>
        <div className="map-legend">
          <span><i className="sensor-dot modis" />MODIS</span>
          <span><i className="sensor-dot viirs" />VIIRS</span>
        </div>
      </header>

      <div className="fire-map-controls">
        <div className="segmented small" role="group" aria-label={t('fireMapHorizonAria')}>
          {GRID_HORIZONS.map((days) => (
            <button
              key={days}
              type="button"
              className={days === horizonDays ? 'active' : undefined}
              aria-pressed={days === horizonDays}
              onClick={() => onHorizonChange(days)}
            >
              {t(HORIZON_KEYS[days])}
            </button>
          ))}
        </div>
        {grid && (
          <span className={`tag fire-confidence ${grid.confidence}`}>
            {t('fireMapConfidence', { level: levelLabel(grid.confidence, t) })}
          </span>
        )}
        {/* Escala qualitativa: a cor vem da densidade do heatmap (vizinhas somadas), não do p de uma
            célula; números só no popup e na célula selecionada. */}
        <div className="fire-chance-legend" aria-hidden="true" title={t('fireMapLegendGlowNote')}>
          <span className="fire-chance-label">{t('fireMapLegendGlow')}</span>
          <span className="fire-chance-bar" />
          <span className="fire-chance-ticks">
            <span>{t('fireMapLegendLower')}</span>
            <span>{t('fireMapLegendHigher')}</span>
          </span>
        </div>
      </div>
      <p className="fire-hypothesis">{t('fireMapHypothesis', { days: daysLabel })}</p>

      <div className="draw-bar">
        <button type="button" className="btn primary" aria-pressed={drawing} onClick={beginDrawing}>
          {drawing ? t('panelCancelDrawing') : t('panelDrawPolygon')}
        </button>
        <button type="button" className="btn" disabled={!drawing || draft.length === 0} onClick={() => setDraft((current) => current.slice(0, -1))}>
          {t('panelUndoPoint')}
        </button>
        <button type="button" className="btn" disabled={draft.length < 3} onClick={() => finishRef.current()}>
          {t('panelClosePolygon')}
        </button>
        <button type="button" className="btn ghost" disabled={!polygon && !drawing && draft.length === 0} onClick={clearPolygon}>
          {t('panelClearSelection')}
        </button>
      </div>

      {mapError ? (
        <div className="map-fallback" role="status">{t('panelMapFailedLoad')}</div>
      ) : (
        <div className="map-frame">
          <div ref={hostRef} className="map" role="region" />
          {gridLoading && <span className="fire-map-loading" role="status">{t('fireMapGridLoading')}</span>}
          <p className="map-hint">
            {drawing
              ? t('panelHintDrawing')
              : polygon
                ? t('panelHintPolygon')
                : grid && grid.cells.length > 0
                  ? t('fireMapHintCells')
                  : t('panelHintBiome')}
          </p>
        </div>
      )}

      <div className="fire-map-notes" aria-live="polite">
        {latestDay && hasLatest && (
          <p className="fire-latest"><i className="fire-pulse-dot" />{t('fireMapLegendLatest', { date: latestDay })}</p>
        )}
        {grid?.windowFrom && grid.windowTo && (
          <p>{t('fireMapWindow', { from: grid.windowFrom, to: grid.windowTo })}</p>
        )}
        {!grid && !gridLoading && <p>{t('fireMapNoGrid')}</p>}
        {selectedCell && (
          <p className="fire-selected">
            {t('fireMapSelectedCell', {
              p: formatChance(selectedCell.p, locale),
              low: formatChance(selectedCell.pLow, locale),
              high: formatChance(selectedCell.pHigh, locale),
              days: daysLabel,
            })}
          </p>
        )}
      </div>
      {caveats.length > 0 && (
        <ul className="fire-caveats">
          {caveats.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
      )}

      <p className="status" id="filter-status" aria-live="polite">{status}</p>
      {hotspotsError && (
        <p className="map-data-error" role="status">
          <span>{t('panelMapDataFailed')}</span>
          <button className="mini-btn" type="button" onClick={onRetryHotspots}>{t('panelRetry')}</button>
        </p>
      )}
      {calendar.mode === 'polygon' && (
        <ul className="weight-inline">
          {activeWeights
            .slice()
            .sort((a, b) => b.weight - a.weight)
            .map((weight) => (
              <li key={weight.id}><i style={{ background: weight.color }} />{weight.name} {formatShare(weight.weight, locale)}</li>
            ))}
        </ul>
      )}
    </article>
  )
}

/** Fontes e camadas sobrepostas, na ordem de desenho (de baixo para cima). */
function addOverlayLayers(map: maplibregl.Map) {
  for (const id of ['biomes', 'polygon', 'hotspots', 'selected-cell', 'draft']) {
    map.addSource(id, { type: 'geojson', data: EMPTY })
  }
  map.addSource('cells', { type: 'geojson', data: EMPTY, promoteId: 'id' })
  // buffer máximo (uma tile inteira): com relevo o heatmap é desenhado tile a tile, e um núcleo cujo
  // raio passa do buffer seria cortado em linha reta na borda da tile (a grade quadrada de volta).
  // O raio de 'cells-glow' nunca passa de 400 px, abaixo dos 512.
  map.addSource('cells-glow', { type: 'geojson', data: EMPTY, promoteId: 'id', buffer: 512 })

  const selected: Expression = ['boolean', ['get', 'selected'], false]
  map.addLayer({
    id: 'biome-fill',
    type: 'fill',
    source: 'biomes',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', selected, 0.1, 0.03] },
  })
  map.addLayer({
    id: 'polygon-fill',
    type: 'fill',
    source: 'polygon',
    paint: { 'fill-color': EMBER, 'fill-opacity': 0.16 },
  })
  map.addLayer({
    id: 'biome-line',
    type: 'line',
    source: 'biomes',
    filter: ['!', selected],
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [3, 3] },
  })
  map.addLayer({
    id: 'biome-line-selected',
    type: 'line',
    source: 'biomes',
    filter: selected,
    paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 1 },
  })
  map.addLayer({
    id: 'polygon-line',
    type: 'line',
    source: 'polygon',
    paint: { 'line-color': EMBER, 'line-width': 2 },
  })
  map.addLayer({
    id: 'hotspots-heat',
    type: 'heatmap',
    source: 'hotspots',
    maxzoom: 8,
    filter: ['!', ['get', 'dim']],
    paint: {
      'heatmap-weight': 1,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 7, 1.4],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 7, 22],
      // Halo discreto e só de perto: na visão geral, anel claro em volta do foco + poça da chama
      // pareciam alvos. Rampa cheia (sem borda mais clara que o miolo), então se lê como mancha.
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 0, 5.5, 0.22, 7, 0.15, 8, 0],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.15, 'rgba(242,113,43,0.12)',
        0.5, 'rgba(242,113,43,0.35)',
        1, 'rgba(255,190,120,0.55)',
      ],
    },
  })
  // Brilho da chance: os centros das células se fundem num campo contínuo de brasa, sem quadrados.
  map.addLayer({
    id: 'cells-glow',
    type: 'heatmap',
    source: 'cells-glow',
    paint: {
      // p^2,2: chance baixa quase não acende; o contraste fica para os núcleos quentes.
      'heatmap-weight': ['^', ['get', 'p'], 2.2],
      // Raio ~2,5 células em px em qualquer zoom: vizinhas se misturam e a borda se esfuma.
      'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 8, 5, 29, 7, 105, 9, 400],
      // Intensidade baixa: com o raio largo cada ponto soma ~5–7 vizinhas, então um campo contínuo
      // de p=1 ainda chega ao topo, p≈0,5 fica laranja fundo e uma célula isolada vira brasa. Mais
      // que isto e regiões inteiras saturam em creme, tudo igual.
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.3, 5, 0.4, 7, 0.45, 9, 0.5],
      'heatmap-color': GLOW_COLOR,
      // Na visão geral deixa o relevo do satélite aparecer através do brilho.
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 7, 0.8],
    },
  })
  // Quadrados transparentes: só servem ao hover e ao clique (queryRenderedFeatures).
  map.addLayer({
    id: 'cells-hit',
    type: 'fill',
    source: 'cells',
    paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
  })
  const hover: Expression = ['boolean', ['feature-state', 'hover'], false]
  // Hover: halo redondo e esfumado no centro da célula (nunca o quadrado de 0,25°, que traria a
  // grade de volta). Raio ~0,6 célula em px, com piso para continuar visível na visão geral.
  map.addLayer({
    id: 'cells-hover',
    type: 'circle',
    source: 'cells-glow',
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 7, 5, 10, 7, 30, 9, 120, 11, 480],
      'circle-color': '#ffb347',
      'circle-opacity': ['case', hover, 0.12, 0],
      'circle-blur': 0.6,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffb347',
      'circle-stroke-opacity': ['case', hover, 0.75, 0],
      'circle-pitch-alignment': 'map',
    },
  })
  const ring: FilterSpecification = ['==', ['get', 'kind'], 'ring']
  map.addLayer({
    id: 'cells-selected-glow',
    type: 'line',
    source: 'selected-cell',
    filter: ring,
    paint: { 'line-color': EMBER, 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.85 },
  })
  map.addLayer({
    id: 'cells-selected-line',
    type: 'line',
    source: 'selected-cell',
    filter: ring,
    paint: { 'line-color': GLOW_TOP, 'line-width': 1.4, 'line-opacity': 0.95 },
  })
  map.addLayer({
    id: 'cells-selected-center',
    type: 'circle',
    source: 'selected-cell',
    filter: ['==', ['get', 'kind'], 'center'],
    paint: {
      'circle-radius': 4,
      'circle-color': GLOW_TOP,
      'circle-blur': 0.4,
      'circle-stroke-width': 2,
      'circle-stroke-color': EMBER,
      'circle-stroke-opacity': 0.8,
      'circle-pitch-alignment': 'map',
    },
  })
  // Chamas 3D (three.js) entram aqui depois, por mountFlames (antes de FLAME_BEFORE_ID).
  // Focos observados acima das chamas: o dado medido não some sob a estimativa.
  const dim: Expression = ['boolean', ['get', 'dim'], false]
  map.addLayer({
    id: 'hotspots-dots',
    type: 'circle',
    source: 'hotspots',
    paint: {
      'circle-color': ['case', ['boolean', ['get', 'modis'], false], MODIS, VIIRS],
      // Pequenos na visão geral: dezenas de pontos grandes viravam um pontilhado por cima do brilho.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', dim, 1, 1.4], 5, ['case', dim, 1.2, 1.8], 8, ['case', dim, 2.4, 4.5]],
      // Focos de outros biomas somem na visão geral (senão viram um pontilhado regular sobre o brilho);
      // os do bioma ficam translúcidos até DOTS_SOLID_ZOOM.
      'circle-opacity': [
        'interpolate', ['linear'], ['zoom'],
        DIM_DOTS_ZOOM - 0.1, ['case', dim, 0, 0.75],
        DIM_DOTS_ZOOM + 0.1, ['case', dim, 0.3, 0.75],
        DOTS_SOLID_ZOOM, ['case', dim, 0.3, 0.95],
      ],
      // Contorno escuro só de perto (o observado se lê por cima do estimado); na visão geral o
      // contorno preto de 1 px virava um salpicado ciano e preto.
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], DOTS_SOLID_ZOOM - 0.5, 0, DOTS_SOLID_ZOOM, ['case', dim, 0, 1]],
      'circle-stroke-color': '#120c08',
      'circle-stroke-opacity': 0.85,
      'circle-pitch-alignment': 'map',
    },
  })
  map.addLayer({
    id: 'hotspots-pulse',
    type: 'circle',
    source: 'hotspots',
    filter: ['all', ['boolean', ['get', 'latest'], false], ['!', dim]],
    paint: {
      'circle-radius': PULSE_REST_RADIUS,
      'circle-opacity': 0,
      'circle-stroke-width': 1,
      'circle-stroke-color': ['case', ['boolean', ['get', 'modis'], false], MODIS, VIIRS],
      'circle-stroke-opacity': PULSE_REST_OPACITY,
      'circle-pitch-alignment': 'map',
    },
  })
  map.addLayer({
    id: 'draft-line',
    type: 'line',
    source: 'draft',
    filter: ['==', ['get', 'kind'], 'line'],
    paint: { 'line-color': EMBER, 'line-width': 2, 'line-dasharray': [2, 2] },
  })
  map.addLayer({
    id: 'draft-vertices',
    type: 'circle',
    source: 'draft',
    filter: ['==', ['get', 'kind'], 'vertex'],
    paint: {
      'circle-radius': ['case', ['boolean', ['get', 'first'], false], 7, 4.5],
      'circle-color': ['case', ['boolean', ['get', 'first'], false], EMBER, '#1a1f25'],
      'circle-stroke-color': '#f2efe8',
      'circle-stroke-width': 2,
    },
  })
}

function setSourceData(map: maplibregl.Map, id: string, data: FeatureCollection) {
  const source = map.getSource(id) as GeoJSONSource | undefined
  source?.setData(data)
}

function cellPolygon(cell: FireCell): Geometry {
  const [[west, south], [east, north]] = cell.bounds
  return {
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  }
}

/**
 * Anel redondo em volta do centro da célula (raio ~0,6 do lado, corrigido pela latitude): marca a
 * escolha sem desenhar o quadrado da grade, que pareceria perímetro.
 */
function cellRing(cell: FireCell): Geometry {
  const [lon, lat] = cell.center
  const radius = CELL_DEG * 0.6
  const squash = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const ring: LonLat[] = []
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2
    ring.push([lon + (Math.cos(a) * radius) / squash, lat + Math.sin(a) * radius])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

/**
 * Câmera que enquadra o anel já inclinado. fitBounds pensa no mapa plano (com a inclinação a borda de
 * perto aumenta e a de longe encolhe, e o anel ficava pequeno e baixo, com o céu do Caribe em cima):
 * parte dele, mede o anel projetado de verdade e corrige zoom e centro duas vezes. As medições usam
 * jumpTo síncrono e voltam à câmera original antes de qualquer quadro ser desenhado.
 */
function pitchedCamera(map: maplibregl.Map, ring: LonLat[]): { center: maplibregl.LngLat; zoom: number } | null {
  const flat = map.cameraForBounds(ringBounds(ring), { padding: FIT_PADDING, bearing: BEARING })
  if (flat?.center === undefined || flat.zoom === undefined) return null
  let center = maplibregl.LngLat.convert(flat.center)
  let zoom = Math.min(FIT_MAX_ZOOM, flat.zoom - PITCH_FIT_ZOOM_OUT)
  const saved = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
  try {
    const canvas = map.getCanvas()
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width <= 2 * FIT_PADDING || height <= 2 * FIT_PADDING) return { center, zoom }
    for (let pass = 0; pass < 2; pass++) {
      map.jumpTo({ center, zoom, pitch: PITCH, bearing: BEARING })
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const point of ring) {
        const { x, y } = map.project(point)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { center, zoom }
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      const fit = Math.min((width - 2 * FIT_PADDING) / Math.max(1, maxX - minX), (height - 2 * FIT_PADDING) / Math.max(1, maxY - minY))
      // Centro do anel projetado vai para o centro da tela, depois o zoom se ajusta ao espaço.
      center = map.unproject([(minX + maxX) / 2, (minY + maxY) / 2])
      zoom = Math.min(FIT_MAX_ZOOM, zoom + Math.log2(fit) * 0.9)
    }
    // Viés para o sul (FIT_SOUTH_BIAS): o anel sobe na tela e o horizonte de oceano sai do quadro.
    zoom = Math.min(FIT_MAX_ZOOM, zoom + FIT_ZOOM_IN)
    map.jumpTo({ center, zoom, pitch: PITCH, bearing: BEARING })
    center = map.unproject([width / 2, height * (0.5 + FIT_SOUTH_BIAS)])
    return { center, zoom }
  } catch {
    return { center, zoom }
  } finally {
    map.jumpTo(saved)
  }
}

function closedRing(ring: LonLat[]): LonLat[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first]
}

function ringBounds(ring: LonLat[]): LngLatBoundsLike {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [[west, south], [east, north]]
}

function pixelDistance(map: maplibregl.Map, a: LonLat, b: LonLat): number {
  const from = map.project(a)
  const to = map.project(b)
  return Math.hypot(from.x - to.x, from.y - to.y)
}

function hasLayer(map: maplibregl.Map, id: string): boolean {
  try {
    return map.getLayer(id) !== undefined
  } catch {
    // Sem estilo (contexto perdido, mapa removido).
    return false
  }
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Avisa quando o elemento entra/sai da tela ou a aba fica oculta/visível (onScreen = as duas
 * coisas). Chama já com o estado atual. Devolve a função que desliga tudo.
 */
function watchOnScreen(host: Element, onChange: (onScreen: boolean) => void): () => void {
  let inView = true
  const emit = () => onChange(inView && !document.hidden)
  const observer = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting)
        emit()
      })
    : null
  observer?.observe(host)
  document.addEventListener('visibilitychange', emit)
  emit()
  return () => {
    observer?.disconnect()
    document.removeEventListener('visibilitychange', emit)
  }
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const onChange = () => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function horizonLabel(days: number, text: PanelText): string {
  return days === 1 ? text.t('fireMapDays1') : text.t('fireMapDaysN', { n: days.toLocaleString(text.locale) })
}

/** Contagem esperada com casas suficientes para valores pequenos (λ costuma ser < 1). */
function formatExpected(value: number, text: PanelText): string {
  if (value >= 10) return formatCount(value, text.locale)
  return value.toLocaleString(text.locale, { maximumFractionDigits: value >= 1 ? 1 : 2 })
}

/** Campos do popup gravados no feature (só primitivos: null vira string vazia). */
function hotspotProperties(hotspot: Hotspot) {
  return {
    hid: hotspot.id,
    date: hotspot.date,
    sensor: hotspot.sensor,
    platform: hotspot.platform,
    frp: hotspot.frp === null ? '' : hotspot.frp,
    conf: hotspot.confidence === null ? '' : hotspot.confidence,
    lon: hotspot.lon,
    lat: hotspot.lat,
  }
}

function hotspotFromProperties(properties: Record<string, unknown> | null | undefined): Hotspot | null {
  if (!properties) return null
  const lon = Number(properties.lon)
  const lat = Number(properties.lat)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const optional = (value: unknown) => (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value))
  return {
    id: String(properties.hid ?? ''),
    date: String(properties.date ?? ''),
    regionId: '',
    sensor: String(properties.sensor ?? ''),
    platform: String(properties.platform ?? ''),
    frp: optional(properties.frp),
    confidence: optional(properties.conf),
    lon,
    lat,
  }
}

function hotspotHtml(hotspot: Hotspot, text: PanelText): string {
  return text.t('panelHotspotTip', {
    date: escapeHtml(hotspot.date),
    sensor: escapeHtml(hotspot.sensor),
    platform: escapeHtml(hotspot.platform),
    frp: hotspot.frp === null ? '—' : escapeHtml(hotspot.frp.toLocaleString(text.locale)),
    confidence: escapeHtml(String(hotspot.confidence ?? '—')),
  })
}

function cellHtml(cell: FireCell, horizonDays: number, text: PanelText): string {
  return text.t('fireMapCellTip', {
    p: escapeHtml(formatChance(cell.p, text.locale)),
    days: escapeHtml(horizonLabel(horizonDays, text)),
    low: escapeHtml(formatChance(cell.pLow, text.locale)),
    high: escapeHtml(formatChance(cell.pHigh, text.locale)),
    observed: escapeHtml(formatCount(cell.observed, text.locale)),
    expected: escapeHtml(formatExpected(cell.expected, text)),
  })
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
}, text: PanelText): string {
  const { t, locale } = text
  if (input.hotspotsLoading) return t('panelLoadingHotspots')
  if (input.hotspotsError) return input.hotspotsError
  if (input.drawing) {
    return input.vertices < 3
      ? t('panelDrawingFew', { count: input.vertices, vertices: input.vertices === 1 ? t('panelVertexOne') : t('panelVertexMany') })
      : t('panelDrawingReady', { count: input.vertices })
  }
  if (input.empty) return t('panelStatusEmpty')
  if (input.polygon && input.area !== null) {
    return t('panelStatusPolygon', {
      inside: formatCount(input.inside, locale),
      total: formatCount(input.total, locale),
      area: formatArea(input.area, locale),
    })
  }
  return t('panelStatusFree', { total: formatCount(input.total, locale) })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char] ?? char
  })
}
