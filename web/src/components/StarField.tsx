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

// Fundo estelar em canvas, atrás do conteúdo. Desliga sem custo quando `enabled` é false.
// Com prefers-reduced-motion, desenha uma vez, sem cintilar.
export function StarField({ enabled }: StarFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!enabled || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let stars: Star[] = []
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

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height)
      for (const s of stars) {
        const alpha = reduced ? 0.6 : 0.35 + 0.45 * Math.sin(t * s.speed + s.phase) ** 2
        ctx.fillStyle = `rgba(242, 239, 232, ${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const loop = (t: number) => {
      draw(t)
      frame = requestAnimationFrame(loop)
    }

    build()
    if (reduced) {
      draw(0)
    } else {
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
