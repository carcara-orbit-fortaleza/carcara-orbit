import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { isLandAt } from '../data/land'
import { fetchRecentFires, type RecentFires } from '../data/hotspots'

// Raio da órbita do satélite, acima do halo atmosférico (1.12).
const SATELLITE_RADIUS = 1.35

// Quantos focos reais desenhar. Cada foco vira um sprite, então o número fica limitado.
const FIRE_SAMPLE = 600

// Tamanho da chama pela potência radiativa (FRP, em MW). Sem FRP, usa um valor médio.
function fireSize(frp: number | null): number {
  return 0.04 + (Math.min(frp ?? 5, 40) / 40) * 0.08
}

// Libera geometria, materiais e texturas de um objeto carregado.
function disposeTree(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    if (mesh.material) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      list.forEach((material) => {
        const standard = material as THREE.MeshStandardMaterial
        standard.map?.dispose()
        standard.normalMap?.dispose()
        material.dispose()
      })
    }
  })
}

// Cores do globo. Three.js não lê variáveis CSS, então elas ficam aqui.
const COLOR_OCEAN = new THREE.Color('#0f2a3d') // oceano profundo
const COLOR_LAND = new THREE.Color('#7fb58e') // vegetação, mais clara para aparecer sobre o oceano
const COLOR_EMBER = new THREE.Color('#ff6a1f') // brasa
const COLOR_AMBER = new THREE.Color('#ffc46b') // âmbar, final da chama

// Regiões de demonstração (centros aproximados do recorte do protótipo). Os dados são sintéticos.
const HOTSPOTS: { lat: number; lon: number; count: number }[] = [
  { lat: -4, lon: -60, count: 36 }, // Amazônia
  { lat: -15, lon: -50, count: 30 }, // Cerrado
  { lat: -18, lon: -57, count: 20 }, // Pantanal
  { lat: -9, lon: -40, count: 16 }, // Caatinga
  { lat: -20, lon: -43, count: 14 }, // Mata Atlântica
  { lat: -30, lon: -54, count: 10 }, // Pampa
]

// Pontos candidatos na esfera. Só os que caem sobre terra são mantidos (~1/3).
const DOTS = 8000

// Lat/lon em vetor unitário. lon 0 aponta para a câmera.
function toVector(lat: number, lon: number): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(lat)
  const lambda = THREE.MathUtils.degToRad(lon)
  return new THREE.Vector3(Math.cos(phi) * Math.sin(lambda), Math.sin(phi), Math.cos(phi) * Math.cos(lambda))
}

// Distribuição uniforme de pontos na esfera (espiral de Fibonacci).
function fibonacciSphere(n: number): Float32Array {
  const out = new Float32Array(n * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const theta = golden * i
    out[i * 3] = Math.cos(theta) * r
    out[i * 3 + 1] = y
    out[i * 3 + 2] = Math.sin(theta) * r
  }
  return out
}

// Pontos da espiral de Fibonacci que caem sobre terra, levemente afastados da superfície.
function landDots(n: number): Float32Array {
  const sphere = fibonacciSphere(n)
  const kept: number[] = []
  for (let i = 0; i < n; i++) {
    const x = sphere[i * 3]
    const y = sphere[i * 3 + 1]
    const z = sphere[i * 3 + 2]
    const lat = THREE.MathUtils.radToDeg(Math.asin(y))
    const lon = THREE.MathUtils.radToDeg(Math.atan2(x, z)) // mesma convenção de toVector
    if (isLandAt(lat, lon)) kept.push(x * 1.002, y * 1.002, z * 1.002)
  }
  return new Float32Array(kept)
}

// Textura de chama feita em canvas: um núcleo quente com manchas irregulares. Não há arquivo externo.
function flameTexture(): THREE.CanvasTexture {
  const size = 96
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const blob = (x: number, y: number, r: number, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255,255,255,${alpha})`)
      g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.45})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    // Núcleo na base e manchas menores subindo, para a chama não ser uma bola perfeita.
    blob(size / 2, size * 0.62, size * 0.36, 1)
    blob(size * 0.4, size * 0.4, size * 0.22, 0.8)
    blob(size * 0.62, size * 0.32, size * 0.2, 0.7)
    blob(size * 0.5, size * 0.2, size * 0.14, 0.6)
  }
  return new THREE.CanvasTexture(canvas)
}

// Verifica se o navegador oferece WebGL. Sem ele, o componente mostra a arte estática.
function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

interface Flame {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  base: THREE.Vector3
  jitter: THREE.Vector3
  phase: number
  speed: number
  size: number
}

interface GlobeProps {
  animated: boolean
  label: string
}

export default function Globe({ animated, label }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Checagem síncrona de WebGL, antes de montar o efeito.
  const [unsupported] = useState(() => !webglSupported())
  // undefined = carregando; null = sem dados reais (demonstração); objeto = focos reais.
  const [fires, setFires] = useState<RecentFires | null | undefined>(undefined)

  useEffect(() => {
    if (unsupported) return
    const controller = new AbortController()
    fetchRecentFires(FIRE_SAMPLE, controller.signal).then((result) => {
      if (!controller.signal.aborted) setFires(result)
    })
    return () => controller.abort()
  }, [unsupported])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Espera a resposta da API antes de montar o planeta, para não recriar a cena depois.
    if (unsupported || fires === undefined) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    // setSize(..., false) não define o tamanho em CSS. Sem isto, com devicePixelRatio > 1 o canvas
    // fica maior que o contêiner e a Terra aparece cortada e deslocada.
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' })
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // Distância suficiente para o halo (raio 1.12) caber inteiro dentro do quadro.
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
    camera.position.set(0, 0.2, 4.8)

    const globe = new THREE.Group()
    scene.add(globe)

    // Corpo do planeta: oceano escuro, iluminado pela luz principal.
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.MeshStandardMaterial({ color: COLOR_OCEAN, roughness: 0.6, metalness: 0.05 }),
    )
    globe.add(body)

    // Continentes em pontos claros, só sobre a terra.
    const dotsGeometry = new THREE.BufferGeometry()
    dotsGeometry.setAttribute('position', new THREE.BufferAttribute(landDots(DOTS), 3))
    const dots = new THREE.Points(
      dotsGeometry,
      new THREE.PointsMaterial({ color: COLOR_LAND, size: 0.022, sizeAttenuation: true }),
    )
    globe.add(dots)


    // Chamas 3D: sprites com textura de fogo, espalhados sobre cada região e subindo da superfície.
    const flameMap = flameTexture()
    // Focos reais na posição de cada detecção; sem eles, a demonstração por região.
    const specs: { base: THREE.Vector3; size: number; jitter: number }[] = fires
      ? fires.points.map((p) => ({ base: toVector(p.lat, p.lon), size: fireSize(p.frp), jitter: 0.01 }))
      : HOTSPOTS.flatMap((h) =>
          Array.from({ length: h.count }, () => ({
            base: toVector(h.lat, h.lon),
            size: 0.1 + Math.random() * 0.1,
            jitter: 0.04,
          })),
        )
    const flames: Flame[] = specs.map((spec) => {
      const material = new THREE.SpriteMaterial({
        map: flameMap,
        color: COLOR_EMBER,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      })
      const sprite = new THREE.Sprite(material)
      globe.add(sprite)
      const j = spec.jitter
      return {
        sprite,
        material,
        base: spec.base,
        jitter: new THREE.Vector3((Math.random() - 0.5) * j, (Math.random() - 0.5) * j, (Math.random() - 0.5) * j),
        phase: Math.random(),
        speed: 0.25 + Math.random() * 0.35,
        size: spec.size,
      }
    })

    // Modelo texturizado da Terra (CC Attribution, ver rodapé). Enquanto carrega, ou se falhar,
    // fica o planeta procedural acima.
    let cancelled = false
    let model: THREE.Object3D | null = null
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}models/earth-2k.glb`,
      (gltf) => {
        if (cancelled) {
          disposeTree(gltf.scene)
          return
        }
        const loaded = gltf.scene
        // Normaliza o tamanho: diâmetro igual a 2, centrado na origem, para o fogo cair sobre a superfície.
        const box = new THREE.Box3().setFromObject(loaded)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const scale = 2 / Math.max(size.x, size.y, size.z)
        loaded.scale.setScalar(scale)
        loaded.position.copy(center).multiplyScalar(-scale)
        // Alinha a textura à nossa convenção de longitude (lon 0 em +z). Medido no GLB:
        // a longitude geográfica da textura é igual à posição do vértice mais 270°.
        loaded.rotation.y = -Math.PI / 2
        globe.remove(body, dots)
        body.geometry.dispose()
        dotsGeometry.dispose()
        globe.add(loaded)
        model = loaded
      },
      undefined,
      (error) => console.warn('Globe: Earth model unavailable, using procedural planet.', error),
    )

    // Órbita do satélite: fica na cena, e não no grupo do planeta, então não gira com a Terra.
    const orbit = new THREE.Group()
    orbit.rotation.set(0.45, 0, 0.25) // inclinação do plano orbital
    scene.add(orbit)
    const arm = new THREE.Group()
    orbit.add(arm)
    let satellite: THREE.Object3D | null = null
    new GLTFLoader().load(
      `${import.meta.env.BASE_URL}models/satellite.glb`,
      (gltf) => {
        if (cancelled) {
          disposeTree(gltf.scene)
          return
        }
        // Normaliza o satélite para cerca de 0,3 de comprimento e o posiciona na órbita.
        const box = new THREE.Box3().setFromObject(gltf.scene)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const scale = 0.3 / Math.max(size.x, size.y, size.z)
        gltf.scene.scale.setScalar(scale)
        gltf.scene.position.copy(center).multiplyScalar(-scale)
        const holder = new THREE.Group()
        holder.position.set(SATELLITE_RADIUS, 0, 0)
        holder.add(gltf.scene)
        arm.add(holder)
        satellite = holder
      },
      undefined,
      (error) => console.warn('Globe: satellite unavailable.', error),
    )

    const light = new THREE.DirectionalLight(0xffffff, 1.6)
    light.position.set(2.5, 1.5, 2)
    scene.add(light, new THREE.AmbientLight(0xffffff, 0.4))

    globe.rotation.x = 0.25
    globe.rotation.y = 1.0 // enquadra o Brasil de frente no início

    const resize = () => {
      const { clientWidth, clientHeight } = container
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / Math.max(clientHeight, 1)
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    const tmp = new THREE.Vector3()
    const render = (time: number) => {
      const t = time / 1000
      if (animated) {
        globe.rotation.y = 1.0 + Math.sin(t * 0.15) * 0.3
      }
      // Satélite: uma volta a cada ~18 s. Com movimento reduzido, fica parado.
      arm.rotation.y = animated ? t * 0.35 : 0.6
      flames.forEach((f) => {
        const u = animated ? (t * f.speed + f.phase) % 1 : f.phase
        // Sobe da superfície: começa colada ao solo e se afasta ao longo da normal.
        tmp.copy(f.base).add(f.jitter).normalize().multiplyScalar(1.005 + u * 0.08)
        f.sprite.position.copy(tmp)
        // Cresce no início e encolhe no fim, com cor de brasa virando âmbar.
        const s = f.size * (0.5 + 0.9 * u) * (1 - u * 0.4)
        f.sprite.scale.set(s, s, 1)
        f.material.color.copy(COLOR_EMBER).lerp(COLOR_AMBER, u)
        // Aparece rápido, some devagar.
        f.material.opacity = Math.min(1, u / 0.15) * Math.max(0, (1 - u) / 0.85) * 0.9
      })
      renderer.render(scene, camera)
    }

    let frame = 0
    if (animated) {
      const loop = (time: number) => {
        try {
          render(time)
        } catch (error) {
          // Erro no quadro não derruba a página: para a animação e mantém o último quadro.
          console.error('Globe: animation failed', error)
          return
        }
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    } else {
      render(0)
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      if (model) disposeTree(model)
      if (satellite) disposeTree(satellite)
      dotsGeometry.dispose()
      flameMap.dispose()
      flames.forEach((f) => f.material.dispose())
      renderer.dispose()
      container.removeChild(renderer.domElement)
    }
  }, [animated, unsupported, fires])

  // Sem WebGL, a abertura fica sem planeta.
  if (unsupported) return null

  // Só o globo, sem legenda: ele é o destaque da abertura.
  return (
    <div ref={containerRef} role="img" aria-label={label} className="h-full w-full overflow-hidden" />
  )
}
