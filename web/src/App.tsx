import { useState } from 'react'
import { StarField } from './components/StarField'
import { SiteHeader } from './components/SiteHeader'
import { SpaceFooter } from './components/SpaceFooter'
import { Home } from './pages/Home'
import { useI18n } from './i18n/useI18n'

const STARFIELD_KEY = 'carcara-orbit.starfield'

// Preferência do fundo estelar. Sem preferência salva, começa desligado se o usuário pediu menos movimento.
function readStarfield(): boolean {
  try {
    const value = window.localStorage.getItem(STARFIELD_KEY)
    if (value === 'on') return true
    if (value === 'off') return false
  } catch {
    // sem armazenamento: usa o padrão abaixo
  }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function writeStarfield(on: boolean) {
  try {
    window.localStorage.setItem(STARFIELD_KEY, on ? 'on' : 'off')
  } catch {
    // sem persistência
  }
}

function App() {
  const { t } = useI18n()
  const [starfield, setStarfield] = useState<boolean>(readStarfield)

  const toggleStarfield = () => {
    setStarfield((prev) => {
      writeStarfield(!prev)
      return !prev
    })
  }

  return (
    <>
      <StarField enabled={starfield} />

      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-20 focus:rounded focus:bg-(--surface) focus:px-3 focus:py-2"
      >
        {t('appName')}
      </a>

      <SiteHeader starfield={starfield} onToggleStarfield={toggleStarfield} />

      <main id="conteudo" className="mx-auto max-w-5xl px-0">
        <Home />
      </main>

      <SpaceFooter />
    </>
  )
}

export default App
