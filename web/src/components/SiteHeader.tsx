import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/useI18n'
import { LOCALES, type Locale } from '../i18n/messages'

interface SiteHeaderProps {
  starfield: boolean
  onToggleStarfield: () => void
}

const SECTIONS = [
  { id: 'problema', key: 'navProblem' },
  { id: 'solucao', key: 'navSolution' },
  { id: 'metodo', key: 'navMethod' },
  { id: 'estado', key: 'navStatus' },
] as const

export function SiteHeader({ starfield, onToggleStarfield }: SiteHeaderProps) {
  const { t, locale, setLocale } = useI18n()
  const [open, setOpen] = useState(false)

  // Esc fecha o menu no celular.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const starfieldButton = (
    <button
      type="button"
      aria-pressed={starfield}
      onClick={onToggleStarfield}
      className="min-h-10 rounded-md border border-(--line) px-3 py-1 text-left text-sm text-(--fg-muted) hover:text-(--fg) md:min-h-0 md:px-2.5"
    >
      {starfield ? t('starfieldOff') : t('starfieldOn')}
    </button>
  )

  return (
    <header className="sticky top-0 z-10 -mx-4 bg-(--bg)/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-(--bg)/70 md:py-3">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <a href="#topo" className="flex min-w-0 items-center gap-2 font-display text-base font-bold tracking-tight">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" aria-hidden="true" width={32} height={24} className="h-8 w-auto shrink-0" />
          <span className="truncate">{t('appName')}</span>
        </a>

        <nav aria-label="Seções" className="hidden gap-x-4 text-sm md:flex">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-(--fg-muted) hover:text-(--fg)">
              {t(s.key)}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <div role="group" aria-label={t('language')} className="flex rounded-md border border-(--line) p-0.5">
            {LOCALES.map((code: Locale) => (
              <button
                key={code}
                type="button"
                aria-pressed={locale === code}
                onClick={() => setLocale(code)}
                className={`min-h-9 rounded px-2.5 py-0.5 text-sm md:min-h-0 ${
                  locale === code ? 'bg-(--accent) text-(--bg)' : 'text-(--fg-muted) hover:text-(--fg)'
                }`}
              >
                <span className="sm:hidden" aria-hidden="true">{code === 'pt-BR' ? 'PT' : 'EN'}</span>
                <span className="sr-only sm:not-sr-only">{code === 'pt-BR' ? t('languagePt') : t('languageEn')}</span>
              </button>
            ))}
          </div>
          <div className="hidden md:block">{starfieldButton}</div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="menu-movel"
            aria-label="Menu"
            onClick={() => setOpen((value) => !value)}
            className="grid size-10 place-items-center rounded-md border border-(--line) text-(--fg-muted) hover:text-(--fg) md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M3 3l12 12M15 3L3 15" /> : <path d="M2 4.5h14M2 9h14M2 13.5h14" />}
            </svg>
          </button>
        </div>
      </div>

      {open ? (
        <div id="menu-movel" className="mx-auto mt-2 flex max-w-5xl flex-col gap-1 border-t border-(--line) pt-2 md:hidden">
          <nav aria-label="Seções" className="flex flex-col">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setOpen(false)}
                className="flex min-h-11 items-center rounded px-1 text-(--fg-muted) hover:text-(--fg)"
              >
                {t(s.key)}
              </a>
            ))}
          </nav>
          <div className="pb-2">{starfieldButton}</div>
        </div>
      ) : null}
    </header>
  )
}
