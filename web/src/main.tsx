import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n/I18nProvider'

// O painel é uma rota separada. Carregamos o código (e o CSS dele) só quando a URL é /painel.
const PainelRoute = lazy(() => import('./painel/PainelRoute'))
const isPainel = window.location.pathname.replace(/\/+$/, '').startsWith('/painel')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {isPainel ? (
        <Suspense fallback={<p className="painel-status">Carregando painel…</p>}>
          <PainelRoute />
        </Suspense>
      ) : (
        <App />
      )}
    </I18nProvider>
  </StrictMode>,
)
