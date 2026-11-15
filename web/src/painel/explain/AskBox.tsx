import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { MessageKey } from '../../i18n/messages'
import { askExplain, ExplainAskFailure } from '../data/api'
import { levelLabel } from '../lib/panelText'
import type { ExplainAskResponse, ExplainContext, ExplainKind } from './types'

const MAX_QUESTION = 400

const CHIPS: Record<'default' | 'forecast' | 'calibration', MessageKey[]> = {
  default: ['explainAskChipWhy', 'explainAskChipChange', 'explainAskChipLimits'],
  forecast: ['explainAskChipWhy', 'explainAskChipAssumptions', 'explainAskChipLimits'],
  calibration: ['explainAskChipWhy', 'explainAskChipDecide', 'explainAskChipChange'],
}

function chipGroup(kind: ExplainKind): keyof typeof CHIPS {
  if (kind === 'forecast-year' || kind === 'post-plan' || kind === 'forecast-ranking') return 'forecast'
  if (kind === 'confidence' || kind === 'method-factor') return 'calibration'
  return 'default'
}

const ERROR_KEYS: Record<string, MessageKey> = {
  rate_limited: 'explainAskErrRateLimited',
  budget_exhausted: 'explainAskErrBudget',
  invalid_request: 'explainAskErrInvalid',
  upstream_error: 'explainAskErrUpstream',
  network: 'explainAskErrNetwork',
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; response: ExplainAskResponse }
  | { status: 'error'; code: string; httpStatus: number }

/** Nível 3. A pergunta é livre; a resposta é SEMPRE texto simples (nunca HTML). */
export function AskBox({ context }: { context: ExplainContext }) {
  const { t, locale } = useI18n()
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<State>({ status: 'idle' })
  const area = useRef<HTMLTextAreaElement>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = question.trim()
    if (!text || state.status === 'loading') return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({ status: 'loading' })
    try {
      const response = await askExplain({ context, question: text, locale }, controller.signal)
      if (!controller.signal.aborted) setState({ status: 'done', response })
    } catch (reason) {
      if (controller.signal.aborted) return
      if (reason instanceof ExplainAskFailure) setState({ status: 'error', code: reason.code, httpStatus: reason.statusCode })
      else setState({ status: 'error', code: 'unknown', httpStatus: 0 })
    }
  }

  const disabled = state.status === 'error' && state.code === 'explain_disabled'
  if (disabled) {
    return <p className="explain-note" role="status">{t('explainAskDisabled')}</p>
  }

  const loading = state.status === 'loading'
  return (
    <div className="explain-ask">
      <p className="explain-muted">{t('explainAskLead')}</p>
      <div className="explain-chips" role="group" aria-label={t('explainAskChips')}>
        {CHIPS[chipGroup(context.kind)].map((key) => (
          <button
            key={key}
            type="button"
            className="chip"
            onClick={() => {
              setQuestion(t(key))
              area.current?.focus()
            }}
          >
            {t(key)}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="explain-question">{t('explainAskLabel')}</label>
        <textarea
          id="explain-question"
          ref={area}
          rows={3}
          maxLength={MAX_QUESTION}
          value={question}
          placeholder={t('explainAskPlaceholder')}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="explain-ask-foot">
          <span className="explain-muted">{t('explainAskCounter', { count: question.length, max: MAX_QUESTION })}</span>
          <button className="btn primary" type="submit" disabled={loading || question.trim() === ''}>
            {loading ? t('explainAskLoading') : t('explainAskSubmit')}
          </button>
        </div>
      </form>

      <div aria-live="polite" className="explain-ask-result">
        {loading && <p className="explain-muted">{t('explainAskLoading')}</p>}
        {state.status === 'error' && (
          <p className="explain-warn" role="alert">
            {state.code in ERROR_KEYS ? t(ERROR_KEYS[state.code]) : t('explainAskErrUnknown', { status: state.httpStatus })}
          </p>
        )}
        {state.status === 'done' && <Answer response={state.response} />}
      </div>
    </div>
  )
}

function Answer({ response }: { response: ExplainAskResponse }) {
  const { t } = useI18n()
  return (
    <div className="explain-answer">
      {response.insufficient && <p className="explain-note">{t('explainAskInsufficient')}</p>}
      {response.answer.trim() !== '' && (
        <>
          <h4>{t('explainAskAnswer')}</h4>
          {/* Texto simples: o React escapa; nunca usar dangerouslySetInnerHTML aqui. */}
          <p className="explain-answer-text">{response.answer}</p>
        </>
      )}
      {response.citations.length > 0 && (
        <>
          <h4>{t('explainAskCitations')}</h4>
          <ul className="explain-citations">
            {response.citations.map((path) => <li key={path}><code>{path}</code></li>)}
          </ul>
        </>
      )}
      <p className="explain-muted">{t('explainAskModelConfidence', { level: levelLabel(response.confidence, t) })}</p>
      <p className="explain-muted">{t('explainAskModelMeta', { model: response.meta.model })}</p>
    </div>
  )
}
