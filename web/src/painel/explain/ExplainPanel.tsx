import { useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { MessageKey } from '../../i18n/messages'
import { AskBox } from './AskBox'
import { ExplainHistory } from './ExplainHistory'
import { WhatIfSection } from './WhatIfSection'
import { caveatText, paramVars, scalarText, tryT } from './explainText'
import type { ExplainPayload } from './explainState'
import { levelLabel } from '../lib/panelText'
import type { ExplainContext } from './types'

type Props = {
  open: { payload: ExplainPayload; serial: number } | null
  onClose: () => void
}

/** O único <dialog> lateral (showModal => camada superior: fica acima do Leaflet e da navegação móvel). */
export function ExplainPanel({ open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="explain-dialog"
      aria-labelledby="explain-title"
      onClose={onClose}
      onMouseDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // Só fecha se o clique começou E terminou no fundo (soltar o mouse ali após selecionar texto não fecha).
        if (downOnBackdrop.current && event.target === event.currentTarget) ref.current?.close()
        downOnBackdrop.current = false
      }}
    >
      {open && <ExplainBody key={open.serial} payload={open.payload} onClose={() => ref.current?.close()} />}
    </dialog>
  )
}

function ExplainBody({ payload, onClose }: { payload: ExplainPayload; onClose: () => void }) {
  const { t, locale } = useI18n()
  const { context } = payload
  const label = tryT(t, context.labelKey, payload.labelVars) ?? context.labelKey
  const notOperational = context.caveats.some((caveat) => caveat.id === 'not-operational')
  const scopeText =
    context.scope.mode === 'polygon'
      ? t('explainScopePolygon', { name: context.scope.regionName, count: context.scope.weights?.length ?? 0 })
      : t('explainScopeRegion', { name: context.scope.regionName })

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">{t('explainEyebrow')}</p>
          <h2 id="explain-title">{label}</h2>
          <p className="explain-muted">{scopeText}</p>
          <p className="explain-value">
            {t('explainValue')}{' '}
            <strong>{context.value.raw === null ? t('noData') : scalarText(context.value.raw, t, locale)}</strong>
            {context.value.raw !== null && context.value.unit ? ` ${context.value.unit}` : ''}
          </p>
        </div>
        <button className="btn ghost" type="button" onClick={onClose}>{t('panelClose')}</button>
      </header>

      <div className="explain-body">
        {notOperational && (
          <p className="explain-banner" role="note">
            <strong>{t('explainNotOperationalTitle')}</strong> {t('explainNotOperationalShort')}
          </p>
        )}

        <Section id="source" title={t('explainSecSource')}><Source context={context} /></Section>
        <Section id="how" title={t('explainSecHow')}><How context={context} /></Section>
        <Section id="trust" title={t('explainSecTrust')}><Trust context={context} /></Section>
        <Section id="history" title={t('explainSecHistory')}><ExplainHistory history={context.history} /></Section>
        {context.whatChanges.length > 0 && (
          <Section id="change" title={t('explainSecChange')}>
            <ul className="explain-list">
              {context.whatChanges.map((change, index) => (
                <li key={`${change.id}-${index}`}>{tryT(t, `explain.change.${change.id}`, paramVars(change.params, t, locale)) ?? change.id}</li>
              ))}
            </ul>
          </Section>
        )}
        <Section id="caveats" title={t('explainSecCaveats')}>
          {context.caveats.length === 0 ? (
            <p className="explain-muted">{t('explainCaveatNone')}</p>
          ) : (
            <ul className="explain-list caveats">
              {context.caveats.map((caveat, index) => (
                <li key={`${caveat.id}-${index}`} className={caveat.id === 'not-operational' || caveat.id === 'mock-data' ? 'prominent' : undefined}>
                  {caveatText(t, caveat, locale) ?? caveat.id}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {payload.whatIf && context.whatIf && (
          <Section id="whatif" title={t('explainSecWhatIf')}><WhatIfSection spec={context.whatIf} run={payload.whatIf} /></Section>
        )}
        <Section id="ask" title={t('explainSecAsk')}><AskBox context={context} /></Section>
      </div>
    </>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="explain-section" aria-labelledby={`explain-h-${id}`}>
      <h3 id={`explain-h-${id}`}>{title}</h3>
      {children}
    </section>
  )
}

function Source({ context }: { context: ExplainContext }) {
  const { t, locale } = useI18n()
  const { source } = context
  const mode = source.datasetMode === 'mock' ? t('panelModeMock') : source.datasetMode === 'real' ? t('panelModeReal') : t('panelModeUnknown')
  const dash = '—'
  const rows: Array<[MessageKey, string]> = [
    ['explainSrcMode', mode],
    ['explainSrcMethod', source.methodVersion ?? dash],
    ['explainSrcDataset', source.datasetVersion ?? dash],
    ['explainSrcPeriod', source.period ?? dash],
    ['explainSrcBaseline', source.baseline ? `${source.baseline.from}–${source.baseline.to}` : dash],
    ['explainSrcSensors', source.sensors.length ? source.sensors.join(', ') : dash],
  ]
  return (
    <dl className="explain-dl">
      {rows.map(([key, value]) => (
        <div key={key}><dt>{t(key)}</dt><dd className={key === 'explainSrcMode' ? undefined : 'mono'}>{value}</dd></div>
      ))}
      {context.scope.weights && context.scope.weights.length > 0 && (
        <div>
          <dt>{t('explainSrcWeights')}</dt>
          <dd className="mono">{context.scope.weights.map((w) => `${w.regionId}: ${scalarText(w.weight, t, locale)}`).join(' · ')}</dd>
        </div>
      )}
    </dl>
  )
}

function How({ context }: { context: ExplainContext }) {
  const { t, locale } = useI18n()
  const { derivedBy, steps } = context.formula
  return (
    <>
      <p className="explain-muted">
        {derivedBy === 'api'
          ? t('explainHowApi', { version: context.source.methodVersion ?? '—' })
          : t('explainHowClient')}
      </p>
      {steps.length > 0 && (
        <ol className="explain-steps">
          {steps.map((step, index) => (
            <li key={`${step.id}-${index}`}>
              <strong>{tryT(t, `explain.step.${step.id}`) ?? step.id}</strong>
              <code className="explain-expr">{step.expr}</code>
              {Object.keys(step.values).length > 0 && (
                <dl className="explain-values">
                  {Object.entries(step.values).map(([name, value]) => (
                    <div key={name}><dt>{name}</dt><dd>{scalarText(value, t, locale, name)}</dd></div>
                  ))}
                </dl>
              )}
              <p className="explain-result">
                = <strong>{scalarText(step.result, t, locale, step.id === 'confidence' ? 'confidence' : undefined)}</strong>
                {step.result !== null && step.unit ? ` ${step.unit}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function Trust({ context }: { context: ExplainContext }) {
  const { t, locale } = useI18n()
  const { uncertainty } = context
  const { interval } = uncertainty
  const intervalText =
    interval.label === 'none' || (interval.low === null && interval.high === null)
      ? t('explainIntervalNone')
      : `${scalarText(interval.low, t, locale)} – ${scalarText(interval.high, t, locale)}`
  const rows: Array<[MessageKey, string]> = [
    ['explainTrustUncertainty', uncertainty.pct === null ? t('panelNotInformed') : `±${Math.round(uncertainty.pct)}%`],
    ['explainTrustConfidence', uncertainty.confidence ? levelLabel(uncertainty.confidence, t) : t('panelNotInformed')],
    ['explainTrustSample', uncertainty.sampleSize === null ? t('noData') : String(uncertainty.sampleSize)],
  ]
  return (
    <>
      <p className="explain-muted">{t('explainTrustLead')}</p>
      <dl className="explain-dl">
        {rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd className="mono">{value}</dd></div>)}
        <div>
          <dt>{t('explainTrustInterval')}</dt>
          <dd className="mono">{intervalText}</dd>
        </div>
      </dl>
      <p className="explain-muted">{t('explainTrustUncertaintyNote')}</p>
      <p className="explain-muted">{t(interval.label === 'min-max' ? 'explainIntervalMinMax' : interval.label === 'p05-p95' ? 'explainIntervalP' : 'explainIntervalNoneNote')}</p>
    </>
  )
}
