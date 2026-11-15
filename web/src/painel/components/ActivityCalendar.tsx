import { useMemo, useState } from 'react'
import { ANOMALY_SCALE, COUNT_SCALE, anomalyColor, countColor } from '../lib/colors'
import { formatCount, formatSignedPercent } from '../lib/format'
import { usePanelText } from '../lib/panelText'
import { ExplainButton } from '../explain/ExplainButton'
import type { ExplainPayload } from '../explain/explainState'
import type { FilteredCalendar } from '../lib/series'

type Metric = 'count' | 'anomaly'

type Props = {
  years: number[]
  /** Abreviados do mês, no idioma atual (cabeçalho do calendário). */
  months: string[]
  calendar: FilteredCalendar
  caption: string
  period: 'all' | '10'
  currentYear: number
  /** Ex.: "2003–2025". Aparece nos rótulos de anomalia. */
  baselineLabel: string
  emptyMessage: string
  /** Monta o "?" da célula ativa (anoIndex = posição em years). */
  explainCell?: (yearIndex: number, month: number) => () => ExplainPayload | null
}

export function ActivityCalendar({ years, months, calendar, caption, period, currentYear, baselineLabel, emptyMessage, explainCell }: Props) {
  const text = usePanelText()
  const { t, locale } = text
  const [metric, setMetric] = useState<Metric>('count')
  const [flames, setFlames] = useState(false)
  const [active, setActive] = useState<{ yearIndex: number; month: number } | null>(null)
  const visible = years
    .map((year, yearIndex) => ({ year, yearIndex }))
    .filter((item) => period === 'all' || item.year > currentYear - 10)
  const sorted = useMemo(() => {
    const values: number[] = []
    for (const item of visible) {
      for (const value of calendar.counts[item.yearIndex] ?? []) {
        if (value !== null && value > 0) values.push(value)
      }
    }
    values.sort((a, b) => a - b)
    return values
  }, [calendar, visible])
  const flameAt = sorted[Math.floor(sorted.length * 0.9)] ?? Infinity
  const first = visible.find((item) => calendar.counts[item.yearIndex]?.some((value) => value !== null)) ?? null
  // A célula ativa pode ficar inválida ao trocar região, polígono ou período. Nesse caso
  // ela é ignorada e o tabindex volta para a primeira célula com dado.
  const current =
    active &&
    visible.some((item) => item.yearIndex === active.yearIndex) &&
    calendar.counts[active.yearIndex]?.[active.month] != null
      ? active
      : null
  const detail = describe(current, years, calendar, baselineLabel, text)
  const hasAnyValue = visible.some((item) => calendar.counts[item.yearIndex]?.some((value) => value !== null))
  const isEmpty = calendar.mode === 'empty' || !hasAnyValue

  function move(yearIndex: number, month: number, dy: number, dx: number) {
    const rows = visible.map((item) => item.yearIndex)
    let row = rows.indexOf(yearIndex)
    let m = month
    if (row < 0) return
    for (let step = 0; step < rows.length * 12; step++) {
      if (dx !== 0) {
        m += dx
        if (m > 11) {
          m = 0
          row += 1
        }
        if (m < 0) {
          m = 11
          row -= 1
        }
      } else {
        row += dy
      }
      if (row < 0 || row >= rows.length) return
      const y = rows[row]
      if (calendar.counts[y]?.[m] !== null && calendar.counts[y]?.[m] !== undefined) {
        setActive({ yearIndex: y, month: m })
        document.getElementById(`cell-${y}-${m}`)?.focus()
        return
      }
    }
  }

  return (
    <section className="card calendar-card" id="calendar" aria-labelledby="calendar-title">
      <header className="card-head">
        <div>
          <h2 id="calendar-title">{t('panelCalendarTitle')}</h2>
          <p>{caption}</p>
        </div>
        {!isEmpty && <div className="segmented" role="group" aria-label={t('panelMetricAria')}>
          <button type="button" className={metric === 'count' ? 'active' : undefined} aria-pressed={metric === 'count'} onClick={() => setMetric('count')}>{t('panelMetricCount')}</button>
          <button type="button" className={metric === 'anomaly' ? 'active' : undefined} aria-pressed={metric === 'anomaly'} onClick={() => setMetric('anomaly')}>{t('panelMetricAnomaly')}</button>
        </div>}
      </header>

      {!isEmpty && (
        <div className="cell-detail-row">
          <p className="cell-detail" aria-live="polite">{detail}</p>
          {current && explainCell && (
            <ExplainButton
              label={`${capitalize(text.monthLong[current.month])} ${years[current.yearIndex]}`}
              build={explainCell(current.yearIndex, current.month)}
            />
          )}
        </div>
      )}

      {calendar.mode === 'empty' ? (
        <p className="empty-calendar">{t('panelCalendarEmptyPolygon')}</p>
      ) : !hasAnyValue ? (
        <p className="empty-calendar">{emptyMessage}</p>
      ) : (
        <div className="calendar-wrap">
          <div className="calendar" role="grid" aria-label={t('panelCalendarGridLabel')}>
            <div className="cal-row" role="row">
              <div className="cal-head" role="columnheader" aria-label={t('year')} />
              {months.map((month, index) => (
                <div key={month} className="cal-head" role="columnheader" aria-label={text.monthLong[index]}>{month}</div>
              ))}
            </div>
            {visible.map(({ year, yearIndex }) => {
              const partial = year === currentYear && (calendar.counts[yearIndex] ?? []).some((value) => value === null)
              return (
              <div className="cal-row" role="row" key={year}>
                <div className={partial ? 'cal-year partial' : 'cal-year'} role="rowheader" title={partial ? t('panelPartialYear') : undefined}>{year}</div>
                {calendar.counts[yearIndex].map((value, month) => {
                  const anomaly = calendar.anomaly[yearIndex][month]
                  const isActive = current?.yearIndex === yearIndex && current.month === month
                  const tab = isActive || (!current && first?.yearIndex === yearIndex && firstCellMonth(calendar.counts[yearIndex]) === month) ? 0 : -1
                  if (value === null) {
                    return <div key={month} className="cal-cell empty" role="gridcell" aria-label={t('panelCellNoData', { month: text.monthLong[month], year })} />
                  }
                  // Contagem existe mas não há régua de referência: a célula aparece, sem cor de anomalia.
                  const noReference = metric === 'anomaly' && anomaly === null
                  const background = metric === 'count' ? countColor(value, sorted) : anomaly === null ? undefined : anomalyColor(anomaly)
                  const anomalyText = anomaly === null
                    ? t('panelNoRefMean', { baseline: baselineLabel })
                    : t('panelAnomalyOf', { change: formatSignedPercent(anomaly, locale), baseline: baselineLabel })
                  return (
                    <button
                      key={month}
                      id={`cell-${yearIndex}-${month}`}
                      type="button"
                      role="gridcell"
                      className={['cal-cell', isActive ? 'selected' : '', noReference ? 'no-reference' : ''].filter(Boolean).join(' ')}
                      style={{ background }}
                      tabIndex={tab}
                      aria-label={t('panelCellLabel', { month: text.monthLong[month], year, count: formatCount(value, locale), detail: anomalyText })}
                      onMouseEnter={() => setActive({ yearIndex, month })}
                      onFocus={() => setActive({ yearIndex, month })}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') move(yearIndex, month, 0, 1)
                        else if (event.key === 'ArrowLeft') move(yearIndex, month, 0, -1)
                        else if (event.key === 'ArrowDown') move(yearIndex, month, 1, 0)
                        else if (event.key === 'ArrowUp') move(yearIndex, month, -1, 0)
                        else if (event.key === 'Home') move(yearIndex, -1, 0, 1)
                        else if (event.key === 'End') move(yearIndex, 12, 0, -1)
                        else return
                        event.preventDefault()
                      }}
                    >
                      {flames && value >= flameAt && <span className="flame" aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
              )
            })}
          </div>
        </div>
      )}

      {!isEmpty && <footer className="calendar-foot">
        <div className="legend-block">
          <span className="legend-label">{metric === 'count' ? t('panelLegendLessCount') : t('panelLegendBelow')}</span>
          <div className="legend-bar" aria-hidden="true">
            {(metric === 'count' ? COUNT_SCALE : ANOMALY_SCALE).map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </div>
          <span className="legend-label">{metric === 'count' ? t('panelLegendMoreCount') : t('panelLegendAbove')}</span>
        </div>
        <label className="switch">
          <input type="checkbox" checked={flames} onChange={(event) => setFlames(event.target.checked)} />
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          <span className="switch-text">{t('panelFlames')}</span>
        </label>
      </footer>}
    </section>
  )
}

function describe(
  active: { yearIndex: number; month: number } | null,
  years: number[],
  calendar: FilteredCalendar,
  baselineLabel: string,
  text: ReturnType<typeof usePanelText>,
): string {
  const { t, locale } = text
  if (!active) return t('panelCalendarHint')
  const value = calendar.counts[active.yearIndex]?.[active.month]
  const anomaly = calendar.anomaly[active.yearIndex]?.[active.month]
  const month = capitalize(text.monthLong[active.month])
  if (value === null || value === undefined) {
    return t('panelCellNoDataDetail', { month, year: years[active.yearIndex] })
  }
  const anomalyText = anomaly === null || anomaly === undefined
    ? t('panelNoRefMean', { baseline: baselineLabel })
    : t('panelVsAverage', { change: formatSignedPercent(anomaly, locale), baseline: baselineLabel })
  const rawM = calendar.rawModis[active.yearIndex]?.[active.month]
  const rawV = calendar.rawViirs[active.yearIndex]?.[active.month]
  const raw = rawM !== null && rawM !== undefined && rawV !== null && rawV !== undefined
    ? t('panelRawSuffix', { modis: formatCount(rawM, locale), viirs: formatCount(rawV, locale) })
    : ''
  return t('panelCellDetail', { month, year: years[active.yearIndex], count: formatCount(value, locale), anomaly: anomalyText, raw })
}

function firstCellMonth(row: (number | null)[] | undefined): number {
  return row?.findIndex((value) => value !== null) ?? 0
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}
