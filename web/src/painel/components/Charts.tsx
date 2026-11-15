import type { AnnualPoint, ClimatologyMonth } from '../types'

type ClimatologyProps = {
  climatology: ClimatologyMonth[]
  current: (number | null)[]
}

type AnnualProps = {
  annual: AnnualPoint[]
  baseline: number
}

export function ClimatologyChart({ climatology, current }: ClimatologyProps) {
  const width = 640
  const height = 210
  const pad = { left: 36, right: 12, top: 16, bottom: 28 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(
    1,
    ...climatology.map((month) => month.p95),
    ...current.filter((value): value is number => value !== null),
  ) * 1.08
  const x = (index: number) => pad.left + (index / 11) * innerW
  const y = (value: number) => pad.top + innerH - (value / max) * innerH
  const band = [
    ...climatology.map((month, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(month.p95)}`),
    ...climatology.slice().reverse().map((month, index) => `L${x(11 - index)},${y(month.p05)}`),
    'Z',
  ].join(' ')
  const mean = climatology.map((month, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(month.mean)}`).join(' ')
  const known = current
    .map((value, index) => (value === null ? null : `${index === current.findIndex((item) => item !== null) ? 'M' : 'L'}${x(index)},${y(value)}`))
    .filter((part): part is string => part !== null)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Climatologia mensal com faixa de variabilidade e o ano de 2026">
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(max * tick)} y2={y(max * tick)} />
          <text className="axis-label" x={pad.left - 6} y={y(max * tick) + 3} textAnchor="end">{Math.round(max * tick).toLocaleString('pt-BR')}</text>
        </g>
      ))}
      <path d={band} fill="rgba(242,113,43,0.16)" />
      <path d={mean} fill="none" stroke="#f2efe8" strokeWidth="2" />
      <path d={known} fill="none" stroke="#f7a03c" strokeWidth="2" strokeDasharray="5 4" />
      {climatology.map((month, index) => (
        <text key={month.label} className="axis-label" x={x(index)} y={height - 8} textAnchor="middle">{month.label}</text>
      ))}
    </svg>
  )
}

export function AnnualChart({ annual, baseline }: AnnualProps) {
  const width = 640
  const height = 210
  const pad = { left: 40, right: 8, top: 16, bottom: 28 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, baseline, ...annual.map((point) => point.total)) * 1.12
  const slot = innerW / Math.max(annual.length, 1)
  const y = (value: number) => pad.top + innerH - (value / max) * innerH

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Série anual harmonizada com a média de 2003 a 2025">
      <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(baseline)} y2={y(baseline)} />
      <text className="series-label" x={width - pad.right} y={y(baseline) - 4} textAnchor="end">média</text>
      {annual.map((point, index) => {
        const barH = Math.max(0, y(0) - y(point.total))
        return (
          <g key={point.year}>
            <rect
              x={pad.left + index * slot + 2}
              y={y(point.total)}
              width={Math.max(2, slot - 4)}
              height={barH}
              rx="2"
              fill={point.partial ? '#f7a03c' : point.anomaly >= 0 ? '#f2712b' : '#6fb3a8'}
              opacity={point.partial ? 0.85 : 0.9}
            >
              <title>{`${point.year}: ${Math.round(point.total).toLocaleString('pt-BR')} focos (${point.anomaly >= 0 ? '+' : ''}${point.anomaly.toFixed(0)}%)${point.partial ? ' — ano parcial' : ''}`}</title>
            </rect>
            {index % 5 === 0 && (
              <text className="axis-label" x={pad.left + index * slot + slot / 2} y={height - 8} textAnchor="middle">{point.year}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
