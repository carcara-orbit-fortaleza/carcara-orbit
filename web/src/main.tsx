import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n/I18nProvider'
import { PanelLoading } from './painel/PanelLoading'

// O dashboard é uma rota separada. Carregamos o código (e o CSS dele) só quando a URL é /dashboard.
// /painel era o nome antigo: redireciona para não quebrar links existentes.
if (/^\/painel(\/|$)/.test(window.location.pathname)) {
  window.history.replaceState(null, '', window.location.pathname.replace(/^\/painel/, '/dashboard') + window.location.search + window.location.hash)
}
const DashboardRoute = lazy(() => import('./painel/PainelRoute'))
const isDashboard = /^\/dashboard(\/|$)/.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {isDashboard ? (
        <Suspense fallback={<PanelLoading />}>
          <DashboardRoute />
        </Suspense>
      ) : (
        <App />
      )}
    </I18nProvider>
  </StrictMode>,
)
