import { useI18n } from '../../i18n/useI18n'
import { useExplain, type ExplainPayload } from './explainState'

type Props = {
  /** Nome do dado já traduzido; entra no aria-label ("Explicar este dado: …"). */
  label: string
  /** Monta o ExplainContext só ao clicar. */
  build: () => ExplainPayload | null
  className?: string
}

/** Botão "?" redondo. Nunca o coloque dentro de outro elemento interativo. */
export function ExplainButton({ label, build, className }: Props) {
  const { t } = useI18n()
  const { open, disabledReason } = useExplain()
  const off = typeof disabledReason === 'string' && disabledReason !== ''
  return (
    <button
      type="button"
      className={className ? `explain-btn ${className}` : 'explain-btn'}
      aria-label={t('explainOpenLabel', { label })}
      aria-haspopup="dialog"
      aria-disabled={off || undefined}
      aria-description={off ? disabledReason : undefined}
      title={off ? disabledReason : t('explainOpenTitle')}
      onClick={(event) => {
        if (!off) open(build, event.currentTarget)
      }}
    >
      <span aria-hidden="true">?</span>
    </button>
  )
}
