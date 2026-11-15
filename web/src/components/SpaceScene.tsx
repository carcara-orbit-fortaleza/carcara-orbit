import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// Cena do rodapé: skybox de nebulosa ao fundo e um astronauta que o visitante pode girar e acenar.
// Os modelos só são baixados quando a cena se aproxima da tela.

const SKYBOX_URL = `${import.meta.env.BASE_URL}models/skybox-nebula.glb`
const ASTRONAUT_URL = `${import.meta.env.BASE_URL}models/astronaut.glb`

const SKY_RADIUS = 50 // raio do domo; a câmera fica dentro dele
const ASTRONAUT_HEIGHT = 3.1 // altura do astronauta em unidades de cena
const WAVE_SECONDS = 2.4 // duração do aceno
const DRAG_LIMIT_YAW = 1.1
const DRAG_LIMIT_PITCH = 0.35
const CLICK_SLOP_PX = 5 // movimento máximo para contar como clique, e não arraste

// Centraliza um objeto na origem e escala para uma altura alvo (ou diâmetro, no caso do domo).
function fit(object: THREE.Object3D, size: number, mode: 'height' | 'diameter') {
  const box = new THREE.Box3().setFromObject(object)
  const dims = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const current = mode === 'diameter' ? Math.max(dims.x, dims.y, dims.z) / 2 : dims.y
  const scale = size / current
  object.scale.setScalar(scale)
  object.position.copy(center).multiplyScalar(-scale)
}

function disposeTree(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach((material) => {
      ;(material as THREE.MeshStandardMaterial).map?.dispose()
      material.dispose()
    })
  })
}

function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

interface SpaceSceneProps {
  animated: boolean
  label: string
}

export default function SpaceScene({ animated, label }: SpaceSceneProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Carrega só quando a cena está perto da tela.
  const [near, setNear] = useState(false)
  const [supported] = useState(() => webglSupported())

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || near) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    const container = containerRef.current
    if (!near || !supported || !container) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x0a0b0e, 1)
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%', touchAction: 'pan-y' })
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
    camera.position.set(0, 0, 0)

    // Luzes para o astronauta. O domo não depende delas.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(2, 3, 4)
    scene.add(key)

    // Domo: o skybox é girado devagar, o que dá a animação de fundo.
    const sky = new THREE.Group()
    scene.add(sky)

    // Astronauta: um grupo-pivô, para girar sem mexer na posição dentro da cena.
    const astronautPivot = new THREE.Group()
    scene.add(astronautPivot)
    const astronautHome = new THREE.Vector3(1.25, -0.25, -4.6)
    astronautPivot.position.copy(astronautHome)

    let cancelled = false
    let skyModel: THREE.Object3D | null = null
    let astronautModel: THREE.Object3D | null = null

    new GLTFLoader().load(
      SKYBOX_URL,
      (gltf) => {
        if (cancelled) return disposeTree(gltf.scene)
        skyModel = gltf.scene
        fit(skyModel, SKY_RADIUS, 'diameter')
        // A câmera fica por dentro do domo, então as faces precisam ser visíveis dos dois lados.
        skyModel.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          materials.forEach((m) => {
            m.side = THREE.DoubleSide
            m.depthWrite = false
          })
          mesh.renderOrder = -1
        })
        sky.add(skyModel)
      },
      undefined,
      (error) => console.warn('Footer: skybox unavailable.', error),
    )

    new GLTFLoader().load(
      ASTRONAUT_URL,
      (gltf) => {
        if (cancelled) return disposeTree(gltf.scene)
        astronautModel = gltf.scene
        fit(astronautModel, ASTRONAUT_HEIGHT, 'height')
        const holder = new THREE.Group()
        holder.add(astronautModel)
        astronautPivot.add(holder)
      },
      undefined,
      (error) => console.warn('Footer: astronaut unavailable.', error),
    )

    // Interação: arrastar gira o astronauta; clicar nele faz o aceno.
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let yaw = 0
    let pitch = 0
    let dragging = false
    let moved = 0
    let lastX = 0
    let lastY = 0
    let waveStart: number | null = null
    let hovering = false

    const setPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
    }
    const overAstronaut = () => {
      if (!astronautModel) return false
      return raycaster.intersectObject(astronautPivot, true).length > 0
    }

    const onDown = (event: PointerEvent) => {
      setPointer(event)
      if (!overAstronaut()) return
      dragging = true
      moved = 0
      lastX = event.clientX
      lastY = event.clientY
      renderer.domElement.setPointerCapture(event.pointerId)
      renderer.domElement.style.cursor = 'grabbing'
    }
    const onMove = (event: PointerEvent) => {
      if (dragging) {
        const dx = event.clientX - lastX
        const dy = event.clientY - lastY
        moved += Math.abs(dx) + Math.abs(dy)
        lastX = event.clientX
        lastY = event.clientY
        yaw = THREE.MathUtils.clamp(yaw + dx * 0.008, -DRAG_LIMIT_YAW, DRAG_LIMIT_YAW)
        pitch = THREE.MathUtils.clamp(pitch + dy * 0.004, -DRAG_LIMIT_PITCH, DRAG_LIMIT_PITCH)
        return
      }
      setPointer(event)
      hovering = overAstronaut()
      renderer.domElement.style.cursor = hovering ? 'grab' : ''
    }
    const onUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      renderer.domElement.style.cursor = 'grab'
      // Quase sem movimento = clique: dispara o aceno.
      if (moved <= CLICK_SLOP_PX && animated) waveStart = event.timeStamp / 1000
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)

    const resize = () => {
      const { clientWidth, clientHeight } = container
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / Math.max(clientHeight, 1)
      // Em telas estreitas, o astronauta vai para o centro para não sair do quadro.
      astronautHome.x = camera.aspect < 0.9 ? 0 : 1.25
      astronautPivot.position.copy(astronautHome)
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    const render = (time: number) => {
      const t = time / 1000

      // Domo: giro lento e contínuo.
      sky.rotation.y = animated ? t * 0.012 : 0.3

      // Astronauta: balanço suave em repouso; aceno por cima quando clicado.
      let wave = 0
      let waveFade = 0
      if (waveStart !== null) {
        const elapsed = t - waveStart
        if (elapsed < WAVE_SECONDS) {
          const k = elapsed / WAVE_SECONDS
          waveFade = Math.sin(k * Math.PI) // sobe e desce suave
          wave = Math.sin(elapsed * Math.PI * 4) * 0.22 * waveFade
        } else {
          waveStart = null
        }
      }
      const idleBob = animated ? Math.sin(t * 1.1) * 0.06 : 0
      astronautPivot.position.y = astronautHome.y + idleBob + waveFade * 0.12
      astronautPivot.rotation.set(pitch - 0.05 * waveFade, yaw + (animated ? Math.sin(t * 0.5) * 0.08 : 0), wave)
      if (hovering && !dragging) astronautPivot.scale.setScalar(1.03)
      else astronautPivot.scale.setScalar(1)

      renderer.render(scene, camera)
    }

    let frame = 0
    if (animated) {
      const loop = (time: number) => {
        try {
          render(time)
        } catch (error) {
          console.error('Footer: scene failed', error)
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
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      if (skyModel) disposeTree(skyModel)
      if (astronautModel) disposeTree(astronautModel)
      renderer.dispose()
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement)
    }
  }, [near, supported, animated])

  if (!supported) return null

  return (
    <div ref={wrapperRef} className="absolute inset-0">
      <div ref={containerRef} role="img" aria-label={label} className="h-full w-full" />
    </div>
  )
}
