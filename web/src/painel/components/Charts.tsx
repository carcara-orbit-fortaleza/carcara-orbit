import { usePanelText } from '../lib/panelText'
import type { AnnualPoint, ClimatologyMonth } from '../types'

type ClimatologyProps = {
  climatology: ClimatologyMonth[]
  current: (number | null)[]
  currentYear: number
  baselineLabel: string
}

type AnnualProps = {
  annual: AnnualPoint[]
  baseline: number | null
  baselineLabel: string
}

/** Junta pontos consecutivos em trechos de linha; um null interrompe o trecho. */
function linePath(values: (number | null)[], x: (index: number) => number, y: (value: number) => number): string {
  let pen = false
  const parts: string[] = []
  values.forEach((value, index) => {
    if (value === null) {
      pen = false
      return
    }
    parts.push(`${pen ? 'L' : 'M'}${x(index)},${y(value)}`)
    pen = true
  })
  return parts.join(' ')
}

export function ClimatologyChart({ climatology, current, currentYear, baselineLabel }: ClimatologyProps) {
  const { t, locale } = usePanelText()
  const width = 640
  const height = 210
  const pad = { left: 36, right: 12, top: 16, bottom: 28 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(
    1,
    ...climatology.map((month) => month.p95 ?? 0),
    ...current.filter((value): value is number => value !== null),
  ) * 1.08
  const hasReference = climatology.some((month) => month.mean !== null)
  const x = (index: number) => pad.left + (index / 11) * innerW
  const y = (value: number) => pad.top + innerH - (value / max) * innerH
  // A faixa só é desenhada quando todos os meses têm referência; com buracos ela mentiria.
  const fullBand = climatology.every((month) => month.p05 !== null && month.p95 !== null)
  const band = fullBand
    ? [
        ...climatology.map((month, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(month.p95 as number)}`),
        ...climatology.slice().reverse().map((month, index) => `L${x(11 - index)},${y(month.p05 as number)}`),
        'Z',
      ].join(' ')
    : ''
  const mean = linePath(climatology.map((month) => month.mean), x, y)
  const known = linePath(current, x, y)
  const label = hasReference
    ? t('panelClimatologyLabel', { baseline: baselineLabel, year: currentYear })
    : t('panelClimatologyNoRef', { baseline: baselineLabel, year: currentYear })

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(max * tick)} y2={y(max * tick)} />
          <text className="axis-label" x={pad.left - 6} y={y(max * tick) + 3} textAnchor="end">{Math.round(max * tick).toLocaleString(locale)}</text>
        </g>
      ))}
      {band && <path d={band} fill="rgba(242,113,43,0.16)" />}
      {mean && <path d={mean} fill="none" stroke="#f2efe8" strokeWidth="2" />}
      {!hasReference && (
        <text className="series-label" x={pad.left + innerW / 2} y={pad.top + innerH / 2} textAnchor="middle">
          {t('panelNoReferenceYears', { baseline: baselineLabel })}
        </text>
      )}
      <path d={known} fill="none" stroke="#f7a03c" strokeWidth="2" strokeDasharray="5 4" />
      {climatology.map((month, index) => (
        <text key={month.label} className="axis-label" x={x(index)} y={height - 8} textAnchor="middle">{month.label}</text>
      ))}
    </svg>
  )
}

export function AnnualChart({ annual, baseline, baselineLabel }: AnnualProps) {
  const { t, locale } = usePanelText()
  const width = 640
  const height = 210
  const pad = { left: 40, right: 8, top: 16, bottom: 28 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, baseline ?? 0, ...annual.map((point) => point.total ?? 0)) * 1.12
  const slot = innerW / Math.max(annual.length, 1)
  const y = (value: number) => pad.top + innerH - (value / max) * innerH

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={baseline === null ? t('panelAnnualLabelNoRef', { baseline: baselineLabel }) : t('panelAnnualLabel', { baseline: baselineLabel })}
    >
      {baseline !== null && (
        <>
          <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(baseline)} y2={y(baseline)} />
          <text className="series-label" x={width - pad.right} y={y(baseline) - 4} textAnchor="end">{t('panelAverage')}</text>
        </>
      )}
      {annual.map((point, index) => {
        const total = point.total
        const anomaly = point.anomaly
        const anomalyText = anomaly === null ? t('panelNoReference') : `${anomaly >= 0 ? '+' : ''}${anomaly.toFixed(0)}%`
        return (
          <g key={point.year}>
            {total !== null && (
              <rect
                x={pad.left + index * slot + 2}
                y={y(total)}
                width={Math.max(2, slot - 4)}
                height={Math.max(0, y(0) - y(total))}
                rx="2"
                fill={point.partial ? '#f7a03c' : anomaly === null ? '#8a8f98' : anomaly >= 0 ? '#f2712b' : '#6fb3a8'}
                opacity={point.partial ? 0.85 : 0.9}
              >
                <title>{`${t('panelBarTitle', { year: point.year, total: Math.round(total).toLocaleString(locale), anomaly: anomalyText })}${point.partial ? ` — ${t('panelPartialYear')}` : ''}`}</title>
              </rect>
            )}
            {index % 5 === 0 && (
              <text className="axis-label" x={pad.left + index * slot + slot / 2} y={height - 8} textAnchor="middle">{point.year}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
