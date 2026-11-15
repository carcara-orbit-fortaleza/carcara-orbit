import type { CSSProperties, ReactNode } from 'react'

interface StreakCardProps {
  children: ReactNode
  /** Espaçamento e layout do conteúdo, como p-5 ou flex gap-3. */
  className?: string
  /** Estrelas cadentes. Desligue em cards pequenos, para não cruzar o texto. */
  streaks?: boolean
}

// Traços de estrelas cadentes. Posições e tempos fixos, para o render ser estável.
const STREAKS: { x: string; len: string; d: string; delay: string }[] = [
  { x: '12%', len: '34px', d: '7s', delay: '0s' },
  { x: '34%', len: '26px', d: '9s', delay: '-3s' },
  { x: '58%', len: '42px', d: '6s', delay: '-1.5s' },
  { x: '76%', len: '22px', d: '8s', delay: '-5s' },
  { x: '90%', len: '30px', d: '10s', delay: '-7s' },
]

// Card com estrelas cadentes e brilho na borda ao passar o mouse. Usa os tokens do tema.
// Com prefers-reduced-motion, as estrelas somem (ver index.css).
export function StreakCard({ children, className = '', streaks = true }: StreakCardProps) {
  return (
    <div
      className={`streak-card feature-card relative overflow-hidden ${className}`}
    >
      {streaks ? (
        <span aria-hidden="true" className="streak-layer">
          {STREAKS.map((s, i) => (
            <span
              key={i}
              className="streak"
              style={{ '--x': s.x, '--len': s.len, '--d': s.d, '--delay': s.delay } as CSSProperties}
            />
          ))}
        </span>
      ) : null}
      <div className="relative">{children}</div>
    </div>
  )
}
