// Texto do "?": tradução de ids dinâmicos (passos, ressalvas, mudanças) e formatação de valores crus.
import type { Vars } from '../../i18n/I18nContext'
import { messages, type Locale, type MessageKey } from '../../i18n/messages'
import { levelLabel, type Translate } from '../lib/panelText'
import type { ExplainCaveat, ExplainScalar } from './types'

export function hasKey(key: string): key is MessageKey {
  return key in messages.en
}

/** Traduz uma chave que só se conhece em tempo de execução. null se ela não existe (id novo ainda sem texto). */
export function tryT(t: Translate, key: string, vars?: Vars): string | null {
  return hasKey(key) ? t(key, vars) : null
}

/** Valor cru para a tela. null é "sem dado", nunca 0. */
export function scalarText(value: ExplainScalar | undefined, t: Translate, locale: Locale, name?: string): string {
  if (value === null || value === undefined) return t('noData')
  if (typeof value === 'boolean') return value ? t('explainYes') : t('explainNo')
  if (typeof value === 'number') {
    if (name === 'alertPercentile') return `P${Math.round(value * 100)}`
    // Anos não levam separador de milhar ("2026", não "2.026").
    if (name && /year|baseline|anchor/i.test(name) && Number.isInteger(value)) return String(value)
    return value.toLocaleString(locale, { maximumFractionDigits: 4 })
  }
  if (name === 'confidence') return levelLabel(value, t)
  return value === '' ? '—' : value
}

export function paramVars(params: Record<string, ExplainScalar> | undefined, t: Translate, locale: Locale): Vars {
  const vars: Vars = {}
  // Parâmetro null entra no texto como "—": é ausência de dado, não zero.
  for (const [name, value] of Object.entries(params ?? {})) vars[name] = value === null ? '—' : scalarText(value, t, locale, name)
  return vars
}

/** Texto de uma ressalva. Alguns ids têm variantes escolhidas por parâmetro (kind, cause, n nulo). */
export function caveatText(t: Translate, caveat: ExplainCaveat, locale: Locale): string | null {
  const vars = paramVars(caveat.params, t, locale)
  const params = caveat.params ?? {}
  if (caveat.id === 'insufficient-reference') {
    if (params.n === null || params.n === undefined) return tryT(t, 'explain.caveat.insufficient-reference.unknown', vars)
    if (params.kind === 'descriptive') return tryT(t, 'explain.caveat.insufficient-reference.descriptive', vars)
  }
  const base = tryT(t, `explain.caveat.${caveat.id}`, vars)
  if (caveat.id === 'not-operational' && base !== null && params.cause === 'no-overlap') {
    return `${base} ${tryT(t, 'explain.caveat.not-operational.no-overlap', vars) ?? ''}`.trim()
  }
  return base
}
