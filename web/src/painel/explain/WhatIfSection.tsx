import { useMemo, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { formatCount, formatShare, formatSignedPercent } from '../lib/format'
import type { Locale } from '../../i18n/messages'
import type { Translate } from '../lib/panelText'
import type { WhatIfOutcome, WhatIfRow, WhatIfRunner } from './explainState'
import { scalarText, tryT } from './explainText'
import type { ExplainWhatIfSpec, WhatIfParams } from './types'

type TrendMode = 'keep' | 'none' | 'custom'

function parse(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text)
}

function formatValue(value: number | null, format: WhatIfRow['format'], t: Translate, locale: Locale): string {
  if (value === null) return t('noData')
  switch (format) {
    case 'count': return formatCount(value, locale)
    case 'percent': return formatSignedPercent(value, locale)
    case 'share': return formatShare(value, locale)
    case 'factor': return `×${value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`
    case 'year': return String(Math.round(value))
    case 'years': return String(value)
  }
}

function formatDelta(value: number | null, format: WhatIfRow['format'], t: Translate, locale: Locale): string {
  if (value === null) return '—'
  if (value === 0) return '0'
  const sign = value > 0 ? '+' : '−'
  if (format === 'percent') return formatSignedPercent(value, locale).replace('-', '−')
  const magnitude = formatValue(Math.abs(value), format, t, locale)
  return `${sign}${format === 'factor' ? magnitude.replace('×', '') : magnitude}`
}

/** Nível 2: o usuário muda premissas e vê "era X, agora Y". Os cálculos são do whatif.ts, via runner. */
export function WhatIfSection({ spec, run }: { spec: ExplainWhatIfSpec; run: WhatIfRunner }) {
  const { t, locale } = useI18n()
  const { current } = spec
  const initial = {
    from: String(current.baselineFrom),
    to: String(current.baselineTo),
    percent: String(Math.round(current.alertPercentile * 100)),
    horizon: current.horizonYear === undefined ? '' : String(current.horizonYear),
    trendMode: 'keep' as TrendMode,
    trend: '',
  }
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [percent, setPercent] = useState(initial.percent)
  const [horizon, setHorizon] = useState(initial.horizon)
  const [trendMode, setTrendMode] = useState<TrendMode>(initial.trendMode)
  const [trend, setTrend] = useState(initial.trend)
  const controls = spec.controls
  const has = (control: ExplainWhatIfSpec['controls'][number]) => controls.includes(control)

  // Só entram os parâmetros que diferem do estado atual: o resto mantém o valor original.
  const params = useMemo<WhatIfParams>(() => {
    const out: WhatIfParams = {}
    const differs = (value: number | undefined, base: number | undefined) => value !== undefined && value !== base
    if (controls.includes('baseline')) {
      const f = parse(from)
      const o = parse(to)
      if (differs(f, current.baselineFrom)) out.baselineFrom = f
      if (differs(o, current.baselineTo)) out.baselineTo = o
    }
    if (controls.includes('alertPercentile')) {
      const p = parse(percent)
      if (p !== undefined && !(Math.abs(p / 100 - current.alertPercentile) < 1e-9)) out.alertPercentile = p / 100
    }
    if (controls.includes('horizonYear')) {
      const h = parse(horizon)
      if (differs(h, current.horizonYear)) out.horizonYear = h
    }
    if (controls.includes('trend')) {
      if (trendMode === 'none') out.trendPctDecade = null
      else if (trendMode === 'custom') {
        const v = parse(trend)
        if (v !== undefined) out.trendPctDecade = v
      }
    }
    return out
  }, [from, to, percent, horizon, trendMode, trend, controls, current])

  const changed = Object.keys(params).length > 0
  const outcome = useMemo<WhatIfOutcome | null>(() => (changed ? run(params) : null), [changed, params, run])

  function reset() {
    setFrom(initial.from)
    setTo(initial.to)
    setPercent(initial.percent)
    setHorizon(initial.horizon)
    setTrendMode('keep')
    setTrend('')
  }

  const issueText = (issue: { code: string; param: string; requested: number | null; used: number | null }) =>
    tryT(t, `explain.whatif.issue.${issue.code}`, {
      param: issue.param,
      used: issue.param === 'alertPercentile' && issue.used !== null ? `P${Math.round(issue.used * 100)}` : scalarText(issue.used, t, locale),
    }) ?? issue.code

  return (
    <div className="explain-whatif">
      <p className="explain-muted">{t('explainWhatIfLead')}</p>
      <div className="explain-controls">
        {has('baseline') && (
          <fieldset>
            <legend>{t('explainWhatIfBaseline')}</legend>
            <label>{t('explainWhatIfFrom')}<input type="number" inputMode="numeric" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>{t('explainWhatIfTo')}<input type="number" inputMode="numeric" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </fieldset>
        )}
        {has('trend') && (
          <fieldset>
            <legend>{t('explainWhatIfTrend')}</legend>
            <label>
              <span className="sr">{t('explainWhatIfTrend')}</span>
              <select value={trendMode} onChange={(event) => setTrendMode(event.target.value as TrendMode)}>
                <option value="keep">{t('explainWhatIfTrendKeep')}</option>
                <option value="none">{t('explainWhatIfTrendNone')}</option>
                <option value="custom">{t('explainWhatIfTrendCustom')}</option>
              </select>
            </label>
            {trendMode === 'custom' && (
              <label>{t('explainWhatIfTrendValue')}<input type="number" step="1" value={trend} onChange={(event) => setTrend(event.target.value)} /></label>
            )}
          </fieldset>
        )}
        {has('alertPercentile') && (
          <fieldset>
            <legend>{t('explainWhatIfPercentile')}</legend>
            <label>
              <span className="sr">{t('explainWhatIfPercentile')}</span>
              <input type="number" min={50} max={99} step={1} value={percent} onChange={(event) => setPercent(event.target.value)} />
            </label>
          </fieldset>
        )}
        {has('horizonYear') && (
          <fieldset>
            <legend>{t('explainWhatIfHorizon')}</legend>
            <label>
              <span className="sr">{t('explainWhatIfHorizon')}</span>
              <input type="number" inputMode="numeric" value={horizon} onChange={(event) => setHorizon(event.target.value)} />
            </label>
          </fieldset>
        )}
      </div>
      <button type="button" className="btn ghost explain-reset" onClick={reset} disabled={!changed && trendMode === 'keep'}>{t('explainWhatIfReset')}</button>

      <div aria-live="polite">
        {!changed && <p className="explain-muted">{t('explainWhatIfUnchanged')}</p>}
        {outcome && !outcome.ok && (
          <p className="explain-warn" role="alert">
            {t('explainWhatIfInvalid')}{' '}{outcome.issues.map(issueText).join(' ')}
          </p>
        )}
        {outcome?.ok && (
          <>
            {outcome.insufficient && (
              <p className="explain-warn" role="status">{t('explainWhatIfInsufficient', { n: outcome.insufficient.sampleYears, required: outcome.insufficient.required })}</p>
            )}
            {outcome.issues.length > 0 && <p className="explain-muted">{outcome.issues.map(issueText).join(' ')}</p>}
            <div className="table-scroll">
              <table className="explain-table">
                <caption className="sr">{t('explainWhatIfCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('explainWhatIfMetric')}</th>
                    <th scope="col">{t('explainWhatIfWas')}</th>
                    <th scope="col">{t('explainWhatIfNow')}</th>
                    <th scope="col">{t('explainWhatIfDelta')}</th>
                  </tr>
                </thead>
                <tbody>
                  {outcome.rows.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">{tryT(t, `explain.whatif.row.${item.id}`) ?? item.id}</th>
                      <td>{formatValue(item.before, item.format, t, locale)}</td>
                      <td>{formatValue(item.after, item.format, t, locale)}</td>
                      <td>{formatDelta(item.delta, item.format, t, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="explain-muted">{t('explainWhatIfNote')}</p>
          </>
        )}
      </div>
    </div>
  )
}
