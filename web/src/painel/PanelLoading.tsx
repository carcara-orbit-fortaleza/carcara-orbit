import { useI18n } from '../i18n/useI18n'

// Fallback do Suspense enquanto o código do painel carrega. Precisa de componente para usar o idioma atual.
export function PanelLoading() {
  const { t } = useI18n()
  return <p className="painel-status">{t('panelLoadingDashboard')}</p>
}
