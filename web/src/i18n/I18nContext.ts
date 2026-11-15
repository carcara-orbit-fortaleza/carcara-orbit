import { createContext } from 'react'
import type { Locale, MessageKey } from './messages'

export type Vars = Record<string, string | number>

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, vars?: Vars) => string
  /** Formata número no idioma atual (ex.: 1.234 ou 1,234). */
  formatNumber: (value: number) => string
  /** Nome curto do mês (0 = janeiro) no idioma atual. */
  monthLabel: (monthIndex: number) => string
}

export const I18nContext = createContext<I18nContextValue | null>(null)
