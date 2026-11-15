import { useMemo } from 'react'
import { useI18n } from '../i18n/useI18n'

type Matrix = (number | null)[][]

interface CalendarGridProps {
  years: number[]
  counts: Matrix
  partialYear: number
}

const STEPS = 7

// Converte uma contagem em um degrau da escala (0..6) usando quantis dos valores > 0 da região.
// Assim a diferença entre meses aparece mesmo quando os valores são muito assimétricos.
function buildThresholds(counts: Matrix): number[] {
  const values = counts.flat().filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b)
  if (values.length === 0) return []
  return Array.from({ length: STEPS - 1 }, (_, i) => {
    const idx = Math.floor(((i + 1) / STEPS) * values.length)
    return values[Math.min(idx, values.length - 1)]
  })
}

function stepFor(value: number, thresholds: number[]): number {
  let step = 0
  for (const t of thresholds) {
    if (value >= t) step++
  }
  return Math.min(step, STEPS - 1)
}

export function CalendarGrid({ years, counts, partialYear }: CalendarGridProps) {
  const { t, formatNumber, monthLabel } = useI18n()
  const thresholds = useMemo(() => buildThresholds(counts), [counts])

  // Meses sem dado (null) não recebem cor: mostram o texto "sem dado".
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-[2px] text-xs">
        <caption className="sr-only">{t('calendarCaption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              {t('year')}
            </th>
            {Array.from({ length: 12 }, (_, m) => (
              <th
                key={m}
                scope="col"
                className="pb-1 text-center font-mono font-normal text-(--fg-muted)"
              >
                {monthLabel(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((year, yi) => (
            <tr key={year}>
              <th
                scope="row"
                className="pr-2 text-right font-mono font-normal text-(--fg-muted)"
              >
                {year}
                {year === partialYear ? (
                  <span className="ml-1 text-[10px] uppercase">{t('partial')}</span>
                ) : null}
              </th>
              {counts[yi].map((value, mi) => {
                if (value === null) {
                  return (
                    <td
                      key={mi}
                      aria-label={`${monthLabel(mi)} ${year}: ${t('noData')}`}
                      title={`${monthLabel(mi)} ${year}: ${t('noData')}`}
                      className="h-[18px] min-w-[18px] rounded-[3px] border border-dashed border-(--line)"
                    />
                  )
                }
                const step = stepFor(value, thresholds)
                const label = t('cellLabel', {
                  month: monthLabel(mi),
                  year,
                  count: formatNumber(value),
                })
                return (
                  <td
                    key={mi}
                    aria-label={label}
                    title={label}
                    className="h-[18px] min-w-[18px] rounded-[3px] focus-visible:outline-2"
                    style={{ background: `var(--scale-${step})` }}
                  />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex items-center gap-2 text-xs text-(--fg-muted)">
        <span>{t('scaleLow')}</span>
        <div className="flex" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, i) => (
            <span
              key={i}
              className="h-3 w-6"
              style={{ background: `var(--scale-${i})` }}
            />
          ))}
        </div>
        <span>{t('scaleHigh')}</span>
        <span className="sr-only">{t('scale')}</span>
      </div>
    </div>
  )
}
