import { useI18n } from '../i18n/useI18n'

// O rodapé é sempre escuro (cena espacial), então usa cores fixas e não os tokens do tema.
const SPACE_BG = '#0a0b0e'
const SPACE_FG = '#f2efe8'
const SPACE_MUTED = '#b4b9c2'

export function SpaceFooter() {
  const { t } = useI18n()
  const credits = [
    t('notAffiliated'),
  ]

  return (
    <footer
      aria-label={t('spaceLabel')}
      className="relative left-1/2 mt-16 w-screen -translate-x-1/2 overflow-hidden"
      style={{ backgroundColor: SPACE_BG, color: SPACE_FG }}
    >
      <div className="relative border-t px-6 py-6 text-xs leading-relaxed" style={{ borderColor: 'rgba(255,255,255,0.1)', color: SPACE_MUTED }}>
        <div className="mx-auto max-w-5xl">
          {credits.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>
    </footer>
  )
}
