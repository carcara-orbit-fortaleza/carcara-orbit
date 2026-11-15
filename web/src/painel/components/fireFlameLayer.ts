import maplibregl from 'maplibre-gl'
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl'
import {
  AdditiveBlending,
  Camera,
  NormalBlending,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  Float32BufferAttribute,
} from 'three'
import { CELL_DEG, type FireCell } from '../lib/fireGrid'

// Chamas da grade de chance (camada custom do MapLibre desenhada com three.js).
//
// Cada célula com p ≥ FLAME_MIN_P vira 1 a 3 chamas (na visão geral, só alguns máximos locais e 1
// chama cada): quads verticais instanciados, virados para a câmera pelo rumo atual (a inclinação é fixa, então basta girar em torno do eixo vertical). O
// fragment shader desenha a chama com ruído rolando para cima; mistura aditiva, sem escrever
// profundidade, então não há caixa preta em volta nem ordenação a fazer. Acima das células mais
// quentes sobem fagulhas, e cada chama tem uma poça de brasa no chão (disco aditivo) para não parecer
// solta no ar. A posição é sorteada dentro da célula (hash do id, determinístico) para
// não desenhar a grade: é ilustração da chance, nunca perímetro de queimada.

/** Abaixo disto a célula não ganha chama (só o brilho no chão). */
export const FLAME_MIN_P = 0.05
/**
 * Teto de células com chama. Acima disto ficam as de maior p: o custo é por instância e, com a
 * mistura aditiva, milhares de chamas pequenas só viram um borrão.
 */
export const MAX_FLAME_CELLS = 2500
/** Células com p acima disto soltam fagulhas. */
const EMBER_MIN_P = 0.25
const EMBERS_PER_CELL = 2
/**
 * Altura da chama em metros: base + p^1,6 × faixa. Curva íngreme: chance baixa fica rente ao chão e
 * só os núcleos quentes sobem, para p=0,3 e p=0,9 não parecerem iguais.
 */
const FLAME_BASE_M = 1_500
const FLAME_RANGE_M = 34_000
const HEIGHT_EXP = 1.6
/** Meia largura do quad; corpo gordo para chamas vizinhas se fundirem em línguas, não em estacas. */
const HALF_WIDTH_RATIO = 0.38
/**
 * Inclinação máxima de cada chama (rad, ~±17°), variação de altura e de largura independentes:
 * silhuetas diferentes entre si, não um carimbo repetido.
 */
const MAX_LEAN = 0.3
const HEIGHT_JITTER = 0.5
const WIDTH_JITTER = 0.3
/**
 * Fração das chamas que viram um tufo: 1 ou 2 línguas extras nascendo da mesma base, mais baixas e
 * abertas em leque (mesma instância de poça, que só a principal desenha).
 */
const CLUSTER_SHARE = 0.25
const TONGUE_SPREAD = 0.22
/**
 * Visão geral (zoom < LOW_ZOOM): só células com p ≥ LOW_ZOOM_MIN_P que sejam máximo local (nenhuma
 * já escolhida a até LOW_ZOOM_SPACING células), no máximo LOW_ZOOM_MAX_CELLS, 1 chama por célula:
 * poucos grupos grandes em vez de uma fileira densa (cerca de piquete).
 * As chamas extras (2ª e 3ª) só aparecem a partir de EXTRA_FLAMES_ZOOM. Tudo decidido no vertex
 * shader por instância (aMinZoom), sem refazer buffers ao dar zoom.
 */
const LOW_ZOOM = 5
const LOW_ZOOM_MIN_P = 0.2
const LOW_ZOOM_MAX_CELLS = 180
const LOW_ZOOM_SPACING = 2
const EXTRA_FLAMES_ZOOM = 6
/** Sorteio dentro da célula: meia célula para cada lado e mais um pouco para dentro das vizinhas. */
const JITTER_CELLS = 0.65
/**
 * Afunda a base para a chama nascer dentro do relevo (a elevação é lida no ponto sorteado de cada
 * chama, mas a malha do relevo e o DEM amostrado não batem exatamente).
 */
const SINK_M = 600
/** A poça de brasa fica um pouco acima do relevo (a base da chama está SINK_M abaixo). */
const POOL_LIFT_M = 250
/** Maior zoom de DEM consultado (o da fonte 'dem'); sem tile carregado, cai para os pais. */
const DEM_MAX_ZOOM = 15
/** Diferença de elevação (m) que justifica reenviar as alturas para a GPU. */
const ELEVATION_EPS_M = 50
/** Raio mínimo da poça, em células (de perto ela segue a célula; de longe, a largura da chama). */
const POOL_CELLS = 0.9
/** A poça é elipse deitada: mais larga na direção da tela do que funda. */
const POOL_ASPECT = 1.4
/** Zoom a partir do qual o tamanho é real em metros; abaixo, cresce para continuar visível. */
const TRUE_SIZE_ZOOM = 6.5
const MAX_ZOOM_BOOST = 5
const BOOST_EXP = 0.75
/** ~30 quadros/s: cada quadro redesenha a cena inteira (relevo incluído). */
const FRAME_MS = 33
/**
 * Orçamento da animação, como o pulso dos focos: sem interação com o mapa por este tempo, o laço
 * para e o último quadro fica parado. Mexer no mapa, passar o mouse ou mudar a grade religa.
 */
const AWAKE_MS = 20_000
/** Eventos do mapa que contam como interação (religam a animação). */
const WAKE_EVENTS = ['movestart', 'mousemove', 'touchstart'] as const
/** Instante fixo usado com prefers-reduced-motion (quadro parado e bonito). */
const STILL_TIME = 3.7

export type FireFlameLayer = CustomLayerInterface & {
  setCells(cells: readonly FireCell[]): void
  /** Mapa na tela e aba visível: liga o laço de animação (se o movimento for permitido). */
  setVisible(visible: boolean): void
  setReducedMotion(reduced: boolean): void
  /**
   * Id da célula da chama sob o ponto (px do canvas), a da frente quando há várias; null se nenhuma.
   * As chamas são quads em pé e cobrem chão de outras células na tela: o clique tem de achar a chama.
   */
  pick(point: { x: number; y: number }): string | null
  /** Libera GL e ouvintes. Idempotente; chamado também por onRemove. */
  dispose(): void
}

const VERTEX = /* glsl */ `
  attribute vec3 aCenter;   // mercator relativo à origem (z = base em unidades mercator)
  attribute vec2 aSize;     // meia largura, altura (unidades mercator)
  attribute float aPhase;
  attribute float aHeat;    // p da célula
  attribute vec2 aJitter;   // fator de tamanho: x na visão geral (0,45–1,4), y de perto (0,85–1,15)
  attribute vec2 aShape;    // inclinação (rad) e fator de altura (0,5–1,5), independentes da largura
  attribute float aMinZoom; // abaixo deste zoom a instância some (encolhe até zero)
  uniform mat4 uMatrix;
  uniform vec3 uRight;
  uniform float uTime;
  uniform float uBoost;
  uniform float uZoom;
  varying vec2 vUv;
  varying float vPhase;
  varying float vHeat;
  void main() {
    float show = smoothstep(aMinZoom - 0.35, aMinZoom, uZoom);
    if (show <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float jitter = mix(aJitter.x, aJitter.y, smoothstep(${(LOW_ZOOM - 0.5).toFixed(1)}, ${(LOW_ZOOM + 0.5).toFixed(1)}, uZoom));
    // Respiração da chama: altura oscila um pouco, cada uma no seu tempo.
    float breathe = 0.88 + 0.12 * sin(uTime * (2.3 + aPhase * 1.7) + aPhase * 40.0);
    vec2 size = aSize * uBoost * jitter * show * vec2(1.0, breathe * aShape.y);
    // Inclinação + balanço lento: cisalha o quad com a base parada, cada chama pende para um lado.
    float lean = aShape.x + 0.06 * sin(uTime * (0.9 + aPhase * 0.6) + aPhase * 23.0);
    float across = position.x * size.x + position.y * size.y * tan(lean);
    vec3 world = aCenter + uRight * across + vec3(0.0, 0.0, position.y * size.y);
    vUv = position.xy;
    vPhase = aPhase;
    vHeat = aHeat;
    gl_Position = uMatrix * vec4(world, 1.0);
  }
`

const NOISE = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`

const FLAME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vPhase;
  varying float vHeat;
  ${NOISE}
  void main() {
    float x = vUv.x;            // -1..1
    float y = vUv.y;            // 0 (base) .. 1 (topo)
    float t = uTime * 1.5;
    float n = fbm(vec2(x * 1.7 + vPhase * 13.0, y * 2.4 - t));
    float m = fbm(vec2(x * 3.1 - vPhase * 7.0, y * 4.2 - t * 1.7));
    // Contorno vivo na altura inteira (não só nas pontas): ondulação lateral de ~0,18 da meia
    // largura e largura que pulsa um pouco, senão a silhueta lê como cone reto.
    float side = fbm(vec2(y * 3.2 - t * 1.3, vPhase * 5.0 + x * 0.6));
    float swell = fbm(vec2(y * 2.1 - t * 0.9 + 4.0, vPhase * 3.0 - x * 0.8));
    // Gota: larga embaixo, fina em cima, balançando mais no alto.
    float dx = x + (n - 0.5) * 1.1 * y + (side - 0.47) * 0.6;
    // Barriga redonda embaixo e afinando só na metade de cima (língua, não cone).
    float width = mix(0.9, 0.05, pow(y, 1.35)) * (0.85 + 0.35 * swell);
    float body = 1.0 - smoothstep(width * 0.3, width, abs(dx));
    // Fundo arredondado: o meio nasce no chão e as laterais um pouco acima.
    float base = smoothstep(0.0, 0.18, y + 0.12 * (1.0 - dx * dx));
    // Pontas quebradas em línguas: o corte do topo varia com x e com o ruído.
    float top = 1.0 - smoothstep(0.3, 0.9, y + (m - 0.5) * 0.8 + abs(sin(x * 4.0 + vPhase * 9.0 + n * 3.0)) * 0.12);
    float heat = body * base * top * (0.55 + 0.9 * n);
    // Cor pela altura: núcleo branco-amarelado só no quarto de baixo e no meio; depois âmbar →
    // laranja → vermelho fundo nas pontas, e as bordas puxam para o vermelho.
    float r = abs(dx) / max(width, 0.001);
    float coreW = (1.0 - smoothstep(0.1, 0.3, y)) * (1.0 - smoothstep(0.1, 0.55, r)) * smoothstep(0.35, 0.85, heat);
    vec3 core = vec3(1.0, 0.953, 0.769);   // #fff3c4
    vec3 amber = vec3(1.0, 0.702, 0.278);  // #ffb347
    vec3 orange = vec3(0.941, 0.478, 0.133); // #f07a22
    vec3 deep = vec3(0.722, 0.188, 0.059); // #b8300f
    vec3 color = mix(amber, orange, smoothstep(0.15, 0.45, y + (n - 0.5) * 0.2));
    color = mix(color, deep, smoothstep(0.45, 0.8, y + (m - 0.5) * 0.2));
    color = mix(color, deep, smoothstep(0.55, 1.0, r) * 0.55);
    color = mix(color, core, coreW * (0.55 + 0.45 * vHeat));
    // Corpo externo ~35% mais apagado que o núcleo: sobrepostas, as chamas não estouram em creme.
    float alpha = smoothstep(0.02, 0.45, heat) * mix(0.6, 0.95, coreW) * (0.6 + 0.35 * vHeat);
    // Ponta macia: some acima de ~80% da altura, sem bico duro de estalagmite.
    alpha *= 1.0 - smoothstep(0.55, 0.85, y + (m - 0.5) * 0.15);
    alpha *= smoothstep(1.0, 0.75, y);
    // Base esfumada: os 12% de baixo somem no chão, sem corte reto onde a chama encontra o relevo.
    alpha *= smoothstep(0.0, 0.12, y);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

// Poça de brasa: disco deitado no chão sob cada chama, com a mesma instância (mesmos atributos).
const POOL_VERTEX = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aSize;
  attribute float aHeat;
  attribute vec2 aJitter;
  attribute float aMinZoom;
  attribute float aPool;    // 1 na chama principal; 0 nas línguas extras do tufo (sem poça repetida)
  attribute float aLift;    // altura sobre a base da chama (mercator, na escala da latitude da célula)
  uniform mat4 uMatrix;
  uniform vec3 uRight;
  uniform float uBoost;
  uniform float uZoom;
  uniform float uCell;  // raio mínimo (mercator)
  varying vec2 vUv;
  varying float vHeat;
  void main() {
    float show = smoothstep(aMinZoom - 0.35, aMinZoom, uZoom) * aPool;
    if (show <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(1.0); vHeat = 0.0; return; }
    float jitter = mix(aJitter.x, aJitter.y, smoothstep(${(LOW_ZOOM - 0.5).toFixed(1)}, ${(LOW_ZOOM + 0.5).toFixed(1)}, uZoom));
    float radius = max(uCell, aSize.x * uBoost * jitter * 1.6) * show;
    vUv = vec2(position.x, position.y * 2.0 - 1.0);
    vHeat = aHeat;
    // Elipse: eixo longo na direita da tela, eixo curto na profundidade.
    vec3 forward = vec3(-uRight.y, uRight.x, 0.0);
    vec3 offset = uRight * (vUv.x * radius * ${POOL_ASPECT.toFixed(2)}) + forward * (vUv.y * radius);
    gl_Position = uMatrix * vec4(aCenter + offset + vec3(0.0, 0.0, aLift), 1.0);
  }
`

const POOL_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vHeat;
  void main() {
    // Queda 1 − r² ao quadrado: miolo cheio e borda que some sem anel.
    float g = max(0.0, 1.0 - dot(vUv, vUv));
    g *= g;
    float alpha = g * 0.42 * vHeat;
    if (alpha < 0.003) discard;
    // #ff8a2a nas bordas, mais amarelo no centro das células quentes.
    vec3 color = mix(vec3(1.0, 0.541, 0.165), vec3(1.0, 0.8, 0.42), g * g * vHeat);
    gl_FragColor = vec4(color, alpha);
  }
`

const EMBER_VERTEX = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aSize;     // raio da fagulha, altura máxima da subida
  attribute float aPhase;
  attribute float aHeat;
  attribute vec2 aJitter;
  attribute float aMinZoom;
  uniform mat4 uMatrix;
  uniform vec3 uRight;
  uniform float uTime;
  uniform float uBoost;
  uniform float uZoom;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    if (uZoom < aMinZoom) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vFade = 0.0; return; }
    float life = fract(uTime * (0.16 + aPhase * 0.12) + aPhase * 17.0);
    float rise = life * aSize.y * uBoost;
    float drift = sin(uTime * 1.3 + aPhase * 50.0) * aSize.x * 6.0 * life;
    float r = aSize.x * uBoost * (1.0 - 0.6 * life);
    vec3 world = aCenter + uRight * (position.x * r + drift * uBoost) + vec3(0.0, 0.0, rise + position.y * r * 2.0);
    vUv = vec2(position.x, position.y * 2.0 - 1.0);
    vFade = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.55, 1.0, life)) * (0.5 + 0.5 * aHeat);
    gl_Position = uMatrix * vec4(world, 1.0);
  }
`

const EMBER_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float d = length(vUv);
    float glow = pow(max(0.0, 1.0 - d), 2.2) * vFade;
    if (glow < 0.004) discard;
    gl_FragColor = vec4(mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.86, 0.55), glow), glow);
  }
`

export function createFireFlameLayer({ reducedMotion }: { reducedMotion: boolean }): FireFlameLayer {
  let map: MapLibreMap | null = null
  let renderer: WebGLRenderer | null = null
  let disposed = false
  let reduced = reducedMotion
  let visible = true
  let cells: readonly FireCell[] = []
  let frame = 0
  let lastFrame = 0
  let clock = STILL_TIME
  let clockFrom: number | null = null
  let awakeUntil = 0
  let demSourceId: string | null = null

  const scene = new Scene()
  const camera = new Camera()
  // A origem (mercator, float64 no JS) sai da matriz: as instâncias ficam perto de zero e o float32
  // da GPU não treme em zoom alto.
  const origin = new Vector3()
  const matrix = new Matrix4()
  const shift = new Matrix4()
  const uniforms = {
    uMatrix: { value: new Matrix4() },
    uRight: { value: new Vector3(1, 0, 0) },
    uTime: { value: STILL_TIME },
    uBoost: { value: 1 },
    uZoom: { value: 4 },
    uCell: { value: (POOL_CELLS * CELL_DEG) / 360 },
  }
  // Último quadro desenhado (matriz, rumo, zoom): o pick projeta as chamas exatamente como saíram.
  let drawn = false

  const flames = makeMesh(VERTEX, FLAME_FRAGMENT, uniforms, false)
  const embers = makeMesh(EMBER_VERTEX, EMBER_FRAGMENT, uniforms, true)
  // A poça usa a geometria (instâncias) das chamas; desenhada antes delas, aditiva. Sem teste de
  // profundidade: é um disco plano de ~25 km sobre relevo que não é plano, e o teste cortaria o
  // brilho numa linha dura onde o chão sobe.
  const poolMaterial = makeMaterial(POOL_VERTEX, POOL_FRAGMENT, uniforms, true, false)
  const pool = new Mesh(flames.geometry, poolMaterial)
  pool.frustumCulled = false
  pool.renderOrder = 0
  flames.mesh.renderOrder = 1
  embers.mesh.renderOrder = 2
  scene.add(pool, flames.mesh, embers.mesh)

  // O relevo chega por tiles: refaz a base das chamas pouco depois de chegar um tile do DEM. ('idle'
  // não serve: com a animação ligada o mapa nunca fica ocioso.) Tiles de imagem e setData de GeoJSON
  // não mudam a elevação e são ignorados.
  let elevationTimer: ReturnType<typeof setTimeout> | null = null
  const onSourceData = (event: MapSourceDataEvent) => {
    if (elevationTimer !== null || !event.tile || event.sourceId !== demSourceId) return
    elevationTimer = setTimeout(() => {
      elevationTimer = null
      if (!disposed && refreshElevation()) map?.triggerRepaint()
    }, 400)
  }
  const wake = () => {
    awakeUntil = performance.now() + AWAKE_MS
    updateLoop()
  }

  let flameCells: FireCell[] = []
  // Pontos de amostra do relevo (lon, lat intercalados): um por chama (as línguas do tufo dividem a
  // base) e um por fagulha. Cada instância lê a elevação do próprio ponto, não do centro da célula.
  let samples: number[] = []
  // Elevação (m, já com exagero) por amostra; 0 sem relevo carregado.
  let elevations: number[] = []
  let flameIndex: number[] = []
  let flameSample: number[] = []
  let emberIndex: number[] = []
  let emberSample: number[] = []

  function rebuild() {
    drawn = false
    flameCells = cells
      .filter((cell) => cell.p >= FLAME_MIN_P && Number.isFinite(cell.center[0]) && Number.isFinite(cell.center[1]))
      .sort((a, b) => b.p - a.p)
    if (flameCells.length > MAX_FLAME_CELLS) {
      if (import.meta.env.DEV) console.info(`[fire-flames] ${flameCells.length} células com chama; desenhando só as ${MAX_FLAME_CELLS} de maior chance.`)
      flameCells = flameCells.slice(0, MAX_FLAME_CELLS)
    }
    // Zoom mínimo de cada célula (ainda em ordem de p): na visão geral só máximos locais, guloso
    // do maior p para o menor, cada um apagando as vizinhas a até LOW_ZOOM_SPACING células.
    const cellMinZoom = new Map<string, number>()
    const taken = new Set<string>()
    const key = (i: number, j: number) => `${i}:${j}`
    let overviewCount = 0
    for (const cell of flameCells) {
      let overview = false
      if (overviewCount < LOW_ZOOM_MAX_CELLS && cell.p >= LOW_ZOOM_MIN_P) {
        const i = Math.round(cell.center[0] / CELL_DEG)
        const j = Math.round(cell.center[1] / CELL_DEG)
        overview = true
        for (let di = -LOW_ZOOM_SPACING; di <= LOW_ZOOM_SPACING && overview; di++) {
          for (let dj = -LOW_ZOOM_SPACING; dj <= LOW_ZOOM_SPACING; dj++) {
            if (taken.has(key(i + di, j + dj))) {
              overview = false
              break
            }
          }
        }
        if (overview) {
          taken.add(key(i, j))
          overviewCount++
        }
      }
      cellMinZoom.set(cell.id, overview ? 0 : LOW_ZOOM)
    }
    // De longe para perto no rumo atual (a câmera não gira; sem mapa vale o norte para cima).
    const bearing = ((map?.getBearing() ?? 0) * Math.PI) / 180
    const depth = (cell: FireCell) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat(cell.center)
      return m.x * Math.sin(bearing) - m.y * Math.cos(bearing)
    }
    flameCells.sort((a, b) => depth(b) - depth(a))

    let ox = 0
    let oy = 0
    for (const cell of flameCells) {
      const m = maplibregl.MercatorCoordinate.fromLngLat(cell.center)
      ox += m.x
      oy += m.y
    }
    const count = Math.max(1, flameCells.length)
    origin.set(ox / count, oy / count, 0)

    const flameData: number[][] = [[], [], [], [], [], [], [], [], []]
    const emberData: number[][] = [[], [], [], [], [], [], [], [], []]
    samples = []
    flameIndex = []
    flameSample = []
    emberIndex = []
    emberSample = []
    flameCells.forEach((cell, k) => {
      const rand = seeded(cell.id)
      const unit = maplibregl.MercatorCoordinate.fromLngLat(cell.center).meterInMercatorCoordinateUnits()
      // Poça acima da base, na escala de metros da própria célula (não a da origem).
      const poolLift = (SINK_M + POOL_LIFT_M) * unit
      const minZoom = cellMinZoom.get(cell.id) ?? LOW_ZOOM
      const tall = FLAME_BASE_M + FLAME_RANGE_M * Math.pow(cell.p, HEIGHT_EXP)
      const flamesHere = cell.p >= 0.6 ? 3 : cell.p >= 0.3 ? 2 : 1
      for (let f = 0; f < flamesHere; f++) {
        // Sorteio na célula inteira e um pouco além, para nenhuma fileira denunciar a grade.
        const lon = cell.center[0] + (rand() * 2 - 1) * JITTER_CELLS * CELL_DEG
        const lat = cell.center[1] + (rand() * 2 - 1) * JITTER_CELLS * CELL_DEG
        const sample = samples.length / 2
        samples.push(lon, lat)
        const scale = f === 0 ? 1 : 0.5 + rand() * 0.35
        const height = tall * scale
        const halfWidth = height * HALF_WIDTH_RATIO * (1 + (rand() * 2 - 1) * WIDTH_JITTER)
        const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat])
        // Variação de tamanho: forte na visão geral (poucas chamas, cada uma diferente), leve de perto.
        const jitter = [0.45 + rand() * 0.95, 0.85 + rand() * 0.3]
        const flameMinZoom = f === 0 ? minZoom : Math.max(minZoom, EXTRA_FLAMES_ZOOM)
        const lean = (rand() * 2 - 1) * MAX_LEAN
        const stretch = 1 + (rand() * 2 - 1) * HEIGHT_JITTER
        // Tufo: 1 ou 2 línguas extras da mesma base, mais baixas e abertas para os lados.
        const tongues = rand() < CLUSTER_SHARE ? (rand() < 0.5 ? 2 : 3) : 1
        for (let g = 0; g < tongues; g++) {
          const side = g === 0 ? 0 : g === 1 ? -1 : 1
          const sub = g === 0 ? 1 : 0.55 + rand() * 0.25
          flameData[0].push(m.x - origin.x, m.y - origin.y, 0)
          flameData[1].push(halfWidth * (g === 0 ? 1 : 0.6 + rand() * 0.2) * unit, height * sub * unit)
          flameData[2].push(rand())
          flameData[3].push(cell.p)
          flameData[4].push(jitter[0], jitter[1])
          flameData[5].push(flameMinZoom)
          const tongueLean = side === 0 ? lean : lean + side * (TONGUE_SPREAD + rand() * 0.12)
          flameData[6].push(Math.max(-0.55, Math.min(0.55, tongueLean)), stretch)
          flameData[7].push(g === 0 ? 1 : 0)
          flameData[8].push(poolLift)
          flameIndex.push(k)
          flameSample.push(sample)
        }
      }
      if (cell.p >= EMBER_MIN_P) {
        for (let e = 0; e < EMBERS_PER_CELL; e++) {
          const lon = cell.center[0] + (rand() * 2 - 1) * 0.4 * CELL_DEG
          const lat = cell.center[1] + (rand() * 2 - 1) * 0.4 * CELL_DEG
          const sample = samples.length / 2
          samples.push(lon, lat)
          const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat])
          emberData[0].push(m.x - origin.x, m.y - origin.y, 0)
          emberData[1].push(350 * unit, tall * 2.2 * unit)
          emberData[2].push(rand())
          emberData[3].push(cell.p)
          emberData[4].push(1, 1)
          emberData[5].push(minZoom)
          emberData[6].push(0, 1)
          emberData[7].push(0)
          emberData[8].push(0)
          emberIndex.push(k)
          emberSample.push(sample)
        }
      }
    })
    elevations = sampleElevations()
    flames.fill(flameData)
    embers.fill(emberData)
    applyElevation()
    wake()
  }

  /**
   * Elevação de cada amostra. Um zoom de DEM só para a passada inteira: queryTerrainElevation refaz
   * coveringTiles a cada chamada, o que com milhares de chamas travava a thread principal.
   */
  function sampleElevations(): number[] {
    const out = new Array<number>(samples.length / 2).fill(0)
    const terrain = map?.terrain
    if (!map || !terrain) return out
    const zoom = Math.max(0, Math.min(DEM_MAX_ZOOM, Math.ceil(map.getZoom())))
    for (let s = 0; s < out.length; s++) {
      try {
        const value = terrain.getElevationForLngLatZoom(new maplibregl.LngLat(samples[2 * s], samples[2 * s + 1]), zoom)
        out[s] = Number.isFinite(value) ? value : 0
      } catch {
        out[s] = 0
      }
    }
    return out
  }

  /** z de cada instância = elevação no ponto da instância − SINK_M, em unidades mercator. */
  function applyElevation() {
    const place = (target: typeof flames, index: number[], sampleOf: number[], lift: number) => {
      const centers = target.geometry.getAttribute('aCenter') as InstancedBufferAttribute | undefined
      if (!centers) return
      index.forEach((k, i) => {
        const cell = flameCells[k]
        const unit = maplibregl.MercatorCoordinate.fromLngLat(cell.center).meterInMercatorCoordinateUnits()
        centers.setZ(i, (elevations[sampleOf[i]] + lift) * unit)
      })
      centers.needsUpdate = true
    }
    place(flames, flameIndex, flameSample, -SINK_M)
    place(embers, emberIndex, emberSample, 0)
  }

  function refreshElevation(): boolean {
    const next = sampleElevations()
    let changed = false
    for (let s = 0; s < next.length; s++) {
      if (Math.abs(next[s] - elevations[s]) > ELEVATION_EPS_M) {
        changed = true
        break
      }
    }
    if (changed) {
      elevations = next
      applyElevation()
    }
    return changed
  }

  // Laço de repintura: só com o mapa na tela, aba visível, movimento permitido, chamas para animar e
  // dentro do orçamento (AWAKE_MS desde a última interação).
  function updateLoop() {
    const run = !disposed && map !== null && renderer !== null && visible && !reduced
      && flames.geometry.instanceCount > 0 && performance.now() < awakeUntil
    if (run && frame === 0) {
      frame = requestAnimationFrame(tick)
    } else if (!run && frame !== 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    if (!run) clockFrom = null
  }

  function tick(now: number) {
    frame = 0
    if (now >= awakeUntil) {
      // Orçamento esgotado: o último quadro fica parado até a próxima interação.
      clockFrom = null
      return
    }
    frame = requestAnimationFrame(tick)
    if (now - lastFrame < FRAME_MS) return
    lastFrame = now
    // Relógio só anda enquanto anima: ao voltar à tela a chama continua de onde parou.
    if (clockFrom !== null) clock += Math.min(0.1, (now - clockFrom) / 1000)
    clockFrom = now
    map?.triggerRepaint()
  }

  /** Projeta um ponto do mundo (mercator relativo à origem) para px do canvas; null atrás da câmera. */
  function toScreen(x: number, y: number, z: number, width: number, height: number): [number, number] | null {
    const e = uniforms.uMatrix.value.elements
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12]
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13]
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15]
    if (!(cw > 1e-9)) return null
    return [((cx / cw + 1) / 2) * width, ((1 - cy / cw) / 2) * height]
  }

  const layer: FireFlameLayer = {
    id: 'fire-flames',
    type: 'custom',
    renderingMode: '3d',
    onAdd(target, gl) {
      if (disposed) return
      // three r163+ só roda em WebGL2; o MapLibre cai para WebGL1 em GPUs antigas. Sem WebGL2 a
      // camada fica vazia (o brilho no chão continua) em vez de derrubar o resto do mapa.
      if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return
      try {
        renderer = new WebGLRenderer({ canvas: target.getCanvas(), context: gl, antialias: true })
      } catch (error) {
        if (import.meta.env.DEV) console.warn('[fire-flames] three.js indisponível; mapa segue sem chamas.', error)
        renderer = null
        return
      }
      renderer.autoClear = false
      map = target
      demSourceId = target.getTerrain()?.source ?? null
      target.on('sourcedata', onSourceData)
      for (const type of WAKE_EVENTS) target.on(type, wake)
      rebuild()
    },
    render(gl, options: CustomRenderMethodInput) {
      if (disposed || !renderer || !map || flames.geometry.instanceCount === 0) return
      matrix.fromArray(options.defaultProjectionData.mainMatrix as unknown as number[])
      shift.makeTranslation(origin.x, origin.y, 0)
      uniforms.uMatrix.value.multiplyMatrices(matrix, shift)
      const bearing = (map.getBearing() * Math.PI) / 180
      // Direita da tela no chão (mercator: x leste, y sul).
      uniforms.uRight.value.set(Math.cos(bearing), Math.sin(bearing), 0)
      const zoom = map.getZoom()
      uniforms.uZoom.value = zoom
      uniforms.uBoost.value = Math.min(MAX_ZOOM_BOOST, Math.max(1, Math.pow(2, (TRUE_SIZE_ZOOM - zoom) * BOOST_EXP)))
      uniforms.uTime.value = reduced ? STILL_TIME : clock
      drawn = true
      renderer.resetState()
      // O canvas muda de tamanho com o cartão: o viewport guardado pelo three envelhece.
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      renderer.render(scene, camera)
    },
    onRemove() {
      layer.dispose()
    },
    pick(point) {
      if (disposed || !renderer || !map || !drawn) return null
      const geometry = flames.geometry
      const count = geometry.instanceCount
      const centers = geometry.getAttribute('aCenter')?.array
      const sizes = geometry.getAttribute('aSize')?.array
      const jitters = geometry.getAttribute('aJitter')?.array
      const minZooms = geometry.getAttribute('aMinZoom')?.array
      const shapes = geometry.getAttribute('aShape')?.array
      if (!count || !centers || !sizes || !jitters || !minZooms || !shapes) return null
      const canvas = map.getCanvas()
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const zoom = uniforms.uZoom.value
      const boost = uniforms.uBoost.value
      const rx = uniforms.uRight.value.x
      const ry = uniforms.uRight.value.y
      const near = smoothstep(LOW_ZOOM - 0.5, LOW_ZOOM + 0.5, zoom)
      // Mesma conta do vertex shader, sem a respiração (média 0,94) e sem o balanço lento. O alvo é
      // um trapézio dentro do quad: o corpo visível é largo embaixo, fino em cima e some perto do topo.
      const corners: Array<[number, number]> = [[-0.7, 0], [0.7, 0], [0.25, 0.8], [-0.25, 0.8]]
      const screen: Array<[number, number]> = []
      // As instâncias estão de longe para perto: a primeira que contém o ponto, de trás para frente,
      // é a chama da frente.
      for (let i = count - 1; i >= 0; i--) {
        const show = smoothstep(minZooms[i] - 0.35, minZooms[i], zoom)
        if (show < 0.5) continue
        const jitter = jitters[2 * i] + (jitters[2 * i + 1] - jitters[2 * i]) * near
        const sx = sizes[2 * i] * boost * jitter * show
        const sy = sizes[2 * i + 1] * boost * jitter * show * 0.94 * shapes[2 * i + 1]
        const slant = Math.tan(shapes[2 * i])
        const cx = centers[3 * i]
        const cy = centers[3 * i + 1]
        const cz = centers[3 * i + 2]
        screen.length = 0
        for (const [px, py] of corners) {
          const across = px * sx + py * sy * slant
          const projected = toScreen(cx + rx * across, cy + ry * across, cz + py * sy, width, height)
          if (!projected) break
          screen.push(projected)
        }
        if (screen.length === corners.length && insideConvex(screen, point.x, point.y)) {
          return flameCells[flameIndex[i]]?.id ?? null
        }
      }
      return null
    },
    setCells(next) {
      cells = next
      if (map && !disposed) {
        rebuild()
        map.triggerRepaint()
      }
    },
    setVisible(next) {
      const wasVisible = visible
      visible = next
      if (next && !wasVisible) wake()
      else updateLoop()
    },
    setReducedMotion(next) {
      reduced = next
      wake()
      map?.triggerRepaint()
    },
    dispose() {
      if (disposed) return
      disposed = true
      updateLoop()
      map?.off('sourcedata', onSourceData)
      for (const type of WAKE_EVENTS) map?.off(type, wake)
      if (elevationTimer !== null) clearTimeout(elevationTimer)
      flames.dispose()
      embers.dispose()
      poolMaterial.dispose()
      renderer?.dispose()
      renderer = null
      map = null
    },
  }
  return layer
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Ponto dentro de um polígono convexo (qualquer sentido de giro). */
function insideConvex(points: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let sign = 0
  for (let k = 0; k < points.length; k++) {
    const [ax, ay] = points[k]
    const [bx, by] = points[(k + 1) % points.length]
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (cross === 0) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

type Uniforms = Record<string, { value: unknown }>

function makeMaterial(vertexShader: string, fragmentShader: string, uniforms: Uniforms, additive: boolean, depthTest = true) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest,
    depthWrite: false,
    // Mistura normal (não aditiva): chamas sobrepostas não estouram em branco. Sem escrever
    // profundidade; a ordem de longe para perto vem da ordenação das células em rebuild().
    blending: additive ? AdditiveBlending : NormalBlending,
  })
}

function makeMesh(vertexShader: string, fragmentShader: string, uniforms: Uniforms, additive: boolean) {
  const geometry = new InstancedBufferGeometry()
  // Quad: x em −1..1 (largura), y em 0..1 (da base ao topo).
  geometry.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  geometry.instanceCount = 0
  const material = makeMaterial(vertexShader, fragmentShader, uniforms, additive)
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  return {
    mesh,
    geometry,
    fill([centers, sizes, phases, heats, jitters, minZooms, shapes, pools, lifts]: number[][]) {
      // Libera os buffers antigos na GPU; o three reenvia tudo no próximo desenho.
      geometry.dispose()
      geometry.setAttribute('aCenter', new InstancedBufferAttribute(new Float32Array(centers), 3))
      geometry.setAttribute('aSize', new InstancedBufferAttribute(new Float32Array(sizes), 2))
      geometry.setAttribute('aPhase', new InstancedBufferAttribute(new Float32Array(phases), 1))
      geometry.setAttribute('aHeat', new InstancedBufferAttribute(new Float32Array(heats), 1))
      geometry.setAttribute('aJitter', new InstancedBufferAttribute(new Float32Array(jitters), 2))
      geometry.setAttribute('aMinZoom', new InstancedBufferAttribute(new Float32Array(minZooms), 1))
      geometry.setAttribute('aShape', new InstancedBufferAttribute(new Float32Array(shapes), 2))
      geometry.setAttribute('aPool', new InstancedBufferAttribute(new Float32Array(pools), 1))
      geometry.setAttribute('aLift', new InstancedBufferAttribute(new Float32Array(lifts), 1))
      geometry.instanceCount = phases.length
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/** Gerador pseudoaleatório determinístico a partir do id da célula (mulberry32 sobre FNV-1a). */
function seeded(id: string): () => number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
