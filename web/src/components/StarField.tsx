import { useEffect, useRef } from 'react'

interface StarFieldProps {
  enabled: boolean
}

interface Star {
  x: number
  y: number
  r: number
  phase: number
  speed: number
}

// Cometa: um traço fino e diagonal (45°) que atravessa a tela, com cauda que se apaga.
interface Comet {
  x: number
  y: number
  vx: number
  vy: number
  length: number
}

const COMET_ANGLE = Math.PI / 4
const COMET_COLOR = '72, 220, 249' // ciano, mesmo tom do cometa de referência

// Fundo estelar em canvas, atrás do conteúdo. Desliga sem custo quando `enabled` é false.
// Com prefers-reduced-motion, desenha uma vez, sem cintilar e sem cometas.
export function StarField({ enabled }: StarFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!enabled || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let stars: Star[] = []
    let comets: Comet[] = []
    let nextComet = 0
    let lastT = 0
    let frame = 0
    let width = 0
    let height = 0

    const build = () => {
      const dpr = window.devicePixelRatio || 1
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(180, Math.floor((width * height) / 9000))
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.2 + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.02 + 0.004,
      }))
    }

    // Intervalo aleatório entre aparições (3 a 8 s).
    const scheduleComet = (t: number) => {
      nextComet = t + 3000 + Math.random() * 5000
    }

    const spawnComet = () => {
      const speed = 0.9 + Math.random() * 0.6 // px por ms
      comets.push({
        x: Math.random() * width * 0.9,
        y: -40,
        vx: Math.cos(COMET_ANGLE) * speed,
        vy: Math.sin(COMET_ANGLE) * speed,
        length: 120 + Math.random() * 90,
      })
    }

    const updateComets = (t: number, dt: number) => {
      if (t >= nextComet) {
        spawnComet()
        scheduleComet(t)
      }
      comets = comets.filter((c) => c.x < width + 60 && c.y < height + 60)
      for (const c of comets) {
        c.x += c.vx * dt
        c.y += c.vy * dt
      }
    }

    const drawComets = () => {
      for (const c of comets) {
        const tailX = c.x - Math.cos(COMET_ANGLE) * c.length
        const tailY = c.y - Math.sin(COMET_ANGLE) * c.length
        const grad = ctx.createLinearGradient(tailX, tailY, c.x, c.y)
        grad.addColorStop(0, `rgba(${COMET_COLOR}, 0)`)
        grad.addColorStop(1, `rgba(${COMET_COLOR}, 1)`)
        ctx.save()
        ctx.lineCap = 'round'
        ctx.lineWidth = 1.6
        ctx.strokeStyle = grad
        ctx.shadowColor = `rgba(${COMET_COLOR}, 0.9)`
        ctx.shadowBlur = 8
        ctx.beginPath()
        ctx.moveTo(tailX, tailY)
        ctx.lineTo(c.x, c.y)
        ctx.stroke()
        ctx.restore()
      }
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height)
      for (const s of stars) {
        const alpha = reduced ? 0.6 : 0.35 + 0.45 * Math.sin(t * s.speed + s.phase) ** 2
        ctx.fillStyle = `rgba(242, 239, 232, ${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fill()
      }
      if (!reduced) drawComets()
    }

    const loop = (t: number) => {
      const dt = lastT ? Math.min(t - lastT, 50) : 16
      lastT = t
      updateComets(t, dt)
      draw(t)
      frame = requestAnimationFrame(loop)
    }

    build()
    if (reduced) {
      draw(0)
    } else {
      scheduleComet(0)
      frame = requestAnimationFrame(loop)
    }

    window.addEventListener('resize', build)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', build)
    }
  }, [enabled])

  if (!enabled) return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  )
}
