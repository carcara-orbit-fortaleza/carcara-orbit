import { useMemo } from 'react'
import type { Vars } from '../../i18n/I18nContext'
import type { Locale, MessageKey } from '../../i18n/messages'
import { useI18n } from '../../i18n/useI18n'
import { ApiError } from '../data/api'

export type Translate = (key: MessageKey, vars?: Vars) => string

/** Tudo que o painel precisa para texto: tradução, idioma e nomes de mês no idioma atual. */
export type PanelText = {
  t: Translate
  locale: Locale
  /** Abreviados, na ordem janeiro → dezembro (ex.: "jan" ou "Jan"). */
  monthShort: string[]
  /** Nomes completos, na ordem janeiro → dezembro. */
  monthLong: string[]
}

export function monthNames(locale: Locale, style: 'short' | 'long'): string[] {
  const format = new Intl.DateTimeFormat(locale, { month: style })
  return Array.from({ length: 12 }, (_, index) => format.format(new Date(2026, index, 1)).replace('.', ''))
}

/** Hook do painel. O objeto muda só quando o idioma muda, então pode entrar em dependências de efeitos. */
export function usePanelText(): PanelText {
  const { t, locale } = useI18n()
  return useMemo(
    () => ({ t, locale, monthShort: monthNames(locale, 'short'), monthLong: monthNames(locale, 'long') }),
    [t, locale],
  )
}

/** Texto de erro para a tela. Erros da API carregam a chave; o resto cai na mensagem genérica. */
export function errorText(reason: unknown, t: Translate, fallback: MessageKey = 'panelErrLoad'): string {
  if (reason instanceof ApiError) return t(reason.key, reason.vars)
  return t(fallback)
}

/** Rótulo de nível de confiança ("low", "medium", "high", "estimated"). Valor desconhecido passa como veio. */
export function levelLabel(value: string, t: Translate): string {
  const keys: Record<string, MessageKey> = {
    low: 'panelLevelLow',
    medium: 'panelLevelMedium',
    high: 'panelLevelHigh',
    estimated: 'panelLevelEstimated',
  }
  const key = keys[value]
  return key ? t(key) : value
}
