import { useMemo, useState } from 'react'
import { ANOMALY_SCALE, COUNT_SCALE, anomalyColor, countColor } from '../lib/colors'
import { formatCount, formatSignedPercent, monthName } from '../lib/format'
import type { FilteredCalendar } from '../lib/series'

type Metric = 'count' | 'anomaly'

type Props = {
  years: number[]
  months: string[]
  calendar: FilteredCalendar
  caption: string
  period: 'all' | '10'
}

export function ActivityCalendar({ years, months, calendar, caption, period }: Props) {
  const [metric, setMetric] = useState<Metric>('count')
  const [flames, setFlames] = useState(false)
  const [active, setActive] = useState<{ yearIndex: number; month: number } | null>(null)
  const visible = years
    .map((year, yearIndex) => ({ year, yearIndex }))
    .filter((item) => period === 'all' || item.year >= 2017)
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
  const detail = describe(active, years, calendar)

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
    <section className="card calendar-card" id="calendario" aria-labelledby="calendar-title">
      <header className="card-head">
        <div>
          <h2 id="calendar-title">Calendário de atividade</h2>
          <p>{caption}</p>
        </div>
        <div className="segmented" role="group" aria-label="Métrica do calendário">
          <button type="button" className={metric === 'count' ? 'active' : undefined} aria-pressed={metric === 'count'} onClick={() => setMetric('count')}>Contagem</button>
          <button type="button" className={metric === 'anomaly' ? 'active' : undefined} aria-pressed={metric === 'anomaly'} onClick={() => setMetric('anomaly')}>Anomalia</button>
        </div>
      </header>

      <p className="cell-detail" aria-live="polite">{detail}</p>

      {calendar.mode === 'empty' ? (
        <p className="empty-calendar">
          Nenhuma célula da série cai dentro do polígono. Desenhe sobre uma célula da grade global.
        </p>
      ) : (
        <div className="calendar-wrap">
          <div className="calendar" role="grid" aria-label="Calendário de atividade de queimadas">
            <div className="cal-row" aria-hidden="true">
              <div className="cal-head" />
              {months.map((month) => (
                <div key={month} className="cal-head">{month}</div>
              ))}
            </div>
            {visible.map(({ year, yearIndex }) => (
              <div className="cal-row" key={year}>
                <div className={year === 2026 ? 'cal-year partial' : 'cal-year'} title={year === 2026 ? 'Ano parcial' : undefined}>{year}</div>
                {calendar.counts[yearIndex].map((value, month) => {
                  const anomaly = calendar.anomaly[yearIndex][month]
                  const isActive = active?.yearIndex === yearIndex && active.month === month
                  const tab = isActive || (!active && first?.yearIndex === yearIndex && firstCellMonth(calendar.counts[yearIndex]) === month) ? 0 : -1
                  if (value === null || anomaly === null) {
                    return <div key={month} className="cal-cell empty" role="gridcell" aria-label={`${monthName(month)} de ${year}: sem dado`} />
                  }
                  const background = metric === 'count' ? countColor(value, sorted) : anomalyColor(anomaly)
                  return (
                    <button
                      key={month}
                      id={`cell-${yearIndex}-${month}`}
                      type="button"
                      role="gridcell"
                      className={isActive ? 'cal-cell selected' : 'cal-cell'}
                      style={{ background }}
                      tabIndex={tab}
                      aria-label={`${monthName(month)} de ${year}: ${formatCount(value)} focos harmonizados, anomalia de ${formatSignedPercent(anomaly)} em relação à média de 2003 a 2025`}
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
            ))}
          </div>
        </div>
      )}

      <footer className="calendar-foot">
        <div className="legend-block">
          <span className="legend-label">{metric === 'count' ? 'Menos focos' : 'Abaixo da média'}</span>
          <div className="legend-bar" aria-hidden="true">
            {(metric === 'count' ? COUNT_SCALE : ANOMALY_SCALE).map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </div>
          <span className="legend-label">{metric === 'count' ? 'Mais focos' : 'Acima da média'}</span>
        </div>
        <label className="switch">
          <input type="checkbox" checked={flames} onChange={(event) => setFlames(event.target.checked)} />
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
          <span className="switch-text">Calendário em chamas</span>
        </label>
      </footer>
    </section>
  )
}

function describe(
  active: { yearIndex: number; month: number } | null,
  years: number[],
  calendar: FilteredCalendar,
): string {
  if (!active) return 'Passe o mouse ou use as setas em uma célula para ver a contagem.'
  const value = calendar.counts[active.yearIndex]?.[active.month]
  const anomaly = calendar.anomaly[active.yearIndex]?.[active.month]
  if (value === null || value === undefined || anomaly === null || anomaly === undefined) {
    return `${capitalize(monthName(active.month))} de ${years[active.yearIndex]}: sem dado.`
  }
  const rawM = calendar.rawModis[active.yearIndex]?.[active.month]
  const rawV = calendar.rawViirs[active.yearIndex]?.[active.month]
  const raw = rawM !== null && rawM !== undefined && rawV !== null && rawV !== undefined
    ? ` · MODIS ${formatCount(rawM)} / VIIRS ${formatCount(rawV)}`
    : ''
  return `${capitalize(monthName(active.month))} de ${years[active.yearIndex]} · ${formatCount(value)} focos harmonizados · ${formatSignedPercent(anomaly)} vs. média 2003–2025${raw}.`
}

function firstCellMonth(row: (number | null)[] | undefined): number {
  return row?.findIndex((value) => value !== null) ?? 0
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}
