import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { messages, type Locale, type MessageKey } from './messages'
import { I18nContext, type I18nContextValue, type Vars } from './I18nContext'

const STORAGE_KEY = 'carcara-orbit.locale'

// Preferência salva em localStorage. Falhas de armazenamento (aba privada, bloqueio) são ignoradas.
function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'pt-BR' || value === 'en' ? value : null
  } catch {
    return null
  }
}

function writeStoredLocale(locale: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // sem persistência: a troca vale só para a sessão atual
  }
}

// English is the site default. Visitors can still switch to pt-BR, and that choice is saved.
function detectLocale(): Locale {
  return 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => readStoredLocale() ?? detectLocale(),
  )

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeStoredLocale(next)
  }, [])

  const value = useMemo<I18nContextValue>(() => {
    const dictionary = messages[locale]
    // Caso falte uma chave em en, cai no português em vez de mostrar a chave crua.
    const fallback = messages.en

    const t = (key: MessageKey, vars?: Vars) => {
      const template: string = (dictionary as Record<string, string>)[key] ?? fallback[key]
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
      )
    }

    const numberFormat = new Intl.NumberFormat(locale)
    const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short' })

    return {
      locale,
      setLocale,
      t,
      formatNumber: (n: number) => numberFormat.format(n),
      monthLabel: (monthIndex: number) =>
        monthFormat.format(new Date(2026, monthIndex, 1)).replace('.', ''),
    }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
