import type { ExplainContext } from './types'
import { scalarText, tryT } from './explainText'
import { useI18n } from '../../i18n/useI18n'

const W = 320
const H = 96
const PAD = { left: 4, right: 4, top: 8, bottom: 18 }

/** Barras do histórico. O SVG é decorativo (aria-hidden); o resumo em texto abaixo traz a informação. */
export function ExplainHistory({ history }: { history: ExplainContext['history'] }) {
  const { t, locale } = useI18n()
  const caption = tryT(t, history.labelKey) ?? history.labelKey
  const points = history.points
  const known = points.filter((point) => point.y !== null) as Array<{ x: number | string; y: number; partial?: boolean }>

  if (known.length === 0) {
    return <p className="explain-muted">{points.length === 0 ? t('explainHistoryEmpty') : t('explainHistoryAllNull', { count: points.length })}</p>
  }

  const gaps = points.length - known.length
  const max = Math.max(...known.map((point) => point.y), 0)
  const min = Math.min(...known.map((point) => point.y))
  const scale = max > 0 ? max : 1
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const slot = innerW / points.length
  const base = PAD.top + innerH
  const highlighted = points.find((point) => point.x === history.highlightX)
  const fmt = (value: number | null) => scalarText(value, t, locale)

  const summary = [
    t('explainHistorySummary', { label: caption, count: known.length, first: String(points[0].x), last: String(points[points.length - 1].x), min: fmt(min), max: fmt(max) }),
    highlighted ? t('explainHistoryHighlight', { x: String(highlighted.x), y: fmt(highlighted.y) }) : '',
    gaps > 0 ? t('explainHistoryGaps', { count: gaps }) : '',
    points.some((point) => point.partial) ? t('explainHistoryPartial') : '',
  ].filter(Boolean).join(' ')

  return (
    <figure className="explain-history">
      <figcaption>{caption}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
        <line className="eh-axis" x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} />
        {points.map((point, index) => {
          const x = PAD.left + index * slot
          const isHighlight = point.x === history.highlightX
          if (point.y === null) {
            // Sem dado: marca vazia na linha de base, nunca uma barra de altura zero.
            return <circle key={String(point.x)} className="eh-gap" cx={x + slot / 2} cy={base - 3} r={1.8}><title>{`${point.x}: ${t('noData')}`}</title></circle>
          }
          const height = Math.max(1, (point.y / scale) * innerH)
          return (
            <rect
              key={String(point.x)}
              className={`eh-bar${point.partial ? ' partial' : ''}${isHighlight ? ' hl' : ''}`}
              x={x + 0.8}
              y={base - height}
              width={Math.max(1.5, slot - 1.6)}
              height={height}
              rx={1.5}
            >
              <title>{`${point.x}: ${fmt(point.y)}${point.partial ? ` (${t('panelPartialYear')})` : ''}`}</title>
            </rect>
          )
        })}
        <text className="eh-label" x={PAD.left} y={H - 4}>{String(points[0].x)}</text>
        <text className="eh-label" x={W - PAD.right} y={H - 4} textAnchor="end">{String(points[points.length - 1].x)}</text>
      </svg>
      <p className="explain-muted">{summary}</p>
    </figure>
  )
}
