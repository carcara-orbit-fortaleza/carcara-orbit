import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ActivityCalendar } from './components/ActivityCalendar'
import { AnnualChart, ClimatologyChart } from './components/Charts'
import { FireMap3D } from './components/FireMap3D'
import { RiskCalculator } from './components/RiskCalculator'
import { ExplainButton } from './explain/ExplainButton'
import { ExplainProvider } from './explain/ExplainProvider'
import {
  explainAnnual, explainAnomaly, explainClimatology, explainConfidence, explainCalendarCell, explainCount,
  explainMethodFactor, explainPeak, explainSensorMix, explainTrend, type ExplainData,
} from './explain/builders'
import type { ExplainPayload } from './explain/explainState'
import { polygonRunner } from './explain/whatifAdapters'
import type { ExplainContext } from './explain/types'
import type { Vars } from '../i18n/I18nContext'
import { hotspotWindow, loadHotspotFeed, loadWorkspace } from './data/api'
import { dashboardForPolygon, dashboardForRegion, type DashboardContext } from './lib/dashboard'
import { areaGeoJson, calendarCsv, download, gridCsv, hotspotCsv } from './lib/exportData'
import { buildFireGrid, type FireCell, type FireGrid } from './lib/fireGrid'
import { formatCount } from './lib/format'
import { pointInRing } from './lib/geo'
import { levelLabel, errorText, usePanelText, type PanelText, type Translate } from './lib/panelText'
import { useI18n } from '../i18n/useI18n'
import { LOCALES, type Locale } from '../i18n/messages'
import { localizeWorkspace } from './lib/names'
import { filterCalendar } from './lib/series'
import type { DatasetMeta, Hotspot, LonLat, RegionSeries, Workspace } from './types'
import './App.css'

type Period = 'all' | '10'

const NAV = [
  { hash: '#top', icon: 'grid', label: 'panelNavOverview' },
  { hash: '#calendar', icon: 'calendar', label: 'panelNavCalendar' },
  { hash: '#series', icon: 'chart', label: 'panelNavSeries' },
  { hash: '#map', icon: 'map', label: 'panelNavMap' },
  { hash: '#calculator', icon: 'calc', label: 'panelNavCalculator' },
  { hash: '#methodology', icon: 'info', label: 'panelNavMethod' },
] as const

export default function App() {
  const text = usePanelText()
  const { t, locale } = text
  const { setLocale } = useI18n()
  const [section, setSection] = useState<string>(() => window.location.hash || '#top')
  useEffect(() => {
    const onHash = () => setSection(window.location.hash || '#top')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // Dados como vieram da API. Os nomes de região e bioma são trocados pelo idioma atual abaixo.
  const [raw, setRaw] = useState<Workspace | null>(null)
  const data = useMemo(() => (raw ? localizeWorkspace(raw, locale) : null), [raw, locale])
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  // Instante em que os focos chegaram: fim da janela da grade de chance. Gravado junto com os
  // focos (nunca durante a renderização) para manter buildFireGrid puro e estável.
  const [hotspotsAt, setHotspotsAt] = useState<number | null>(null)
  const [hotspotsTruncated, setHotspotsTruncated] = useState(false)
  // Horizonte da grade de chance (dias) e célula escolhida no mapa (só o id: a célula sai da grade).
  const [horizonDays, setHorizonDays] = useState(7)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  // Guardam o erro cru (ApiError traz chave de tradução); o texto sai na renderização, no idioma atual.
  const [error, setError] = useState<unknown>(null)
  const [hotspotsError, setHotspotsError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [hotspotsLoading, setHotspotsLoading] = useState(true)
  // Sem região fixa: ao carregar, abre na região com mais dado (ver defaultRegionId).
  const [regionId, setRegionId] = useState<string | null>(null)
  const [polygon, setPolygon] = useState<LonLat[] | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const [shellAttempt, setShellAttempt] = useState(0)
  const [pointsAttempt, setPointsAttempt] = useState(0)
  const tableRef = useRef<HTMLDialogElement>(null)
  const methodRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    loadWorkspace()
      .then((workspace) => {
        if (!live) return
        setRaw(workspace)
        setRegionId((current) => current ?? defaultRegionId(workspace.regions))
      })
      .catch((reason: unknown) => {
        if (live) setError(reason)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [shellAttempt])

  const currentYear = data?.meta.currentYear ?? null
  useEffect(() => {
    if (currentYear === null) return
    let live = true
    setHotspotsLoading(true)
    setHotspotsError(null)
    loadHotspotFeed(currentYear)
      .then((feed) => {
        if (!live) return
        setHotspots(feed.hotspots)
        // Fim da janela = última detecção do feed, não a hora em que a página abriu: feed parado
        // não pode diluir a taxa nem apagar a ressalva de janela curta.
        setHotspotsAt(feed.latestMs ?? Date.now())
        setHotspotsTruncated(feed.truncated)
      })
      .catch((reason: unknown) => {
        if (!live) return
        setHotspots([])
        setHotspotsAt(null)
        setHotspotsTruncated(false)
        setHotspotsError(reason)
      })
      .finally(() => {
        if (live) setHotspotsLoading(false)
      })
    return () => {
      live = false
    }
  }, [pointsAttempt, currentYear])

  const region = data?.regions.find((item) => item.id === regionId) ?? data?.regions[0]
  const context = useMemo<DashboardContext | null>(
    () =>
      data
        ? {
            years: data.years,
            currentYear: data.meta.currentYear,
            baseline: { from: data.meta.baselineFrom, to: data.meta.baselineTo },
          }
        : null,
    [data],
  )
  const hotspotRange = currentYear === null ? null : hotspotWindow(currentYear)
  const hotspotWindowLabel = hotspotRange ? `${hotspotRange.from}–${hotspotRange.to}` : ''
  const calendar = useMemo(
    () => (data && region && context ? filterCalendar(data.regions, data.years, polygon, region.id, context.baseline) : null),
    [data, polygon, region, context],
  )
  const insideHotspots = useMemo(() => {
    if (!region) return []
    if (polygon) return hotspots.filter((hotspot) => pointInRing(hotspot.lon, hotspot.lat, polygon))
    return hotspots.filter((hotspot) => hotspot.regionId === region.id)
  }, [hotspots, polygon, region])
  const board = useMemo(() => {
    if (!data || !region || !calendar || !context) return null
    if (polygon) return dashboardForPolygon(calendar, data.regions, insideHotspots.length, context, hotspotWindowLabel, text)
    return dashboardForRegion(region, context, text)
  }, [calendar, context, data, hotspotWindowLabel, insideHotspots.length, polygon, region, text])

  // Grade de chance por célula. Só com focos carregados; se o modelo falhar, o mapa segue só com
  // os focos (grid = null) em vez de derrubar o painel.
  const grid = useMemo<FireGrid | null>(() => {
    if (!data || !context || hotspotsAt === null || hotspotsError !== null) return null
    try {
      // No modo demonstração os focos são uma amostra do mapa, não o feed inteiro.
      const incompleteFeed = hotspotsTruncated || data.meta.mode === 'mock'
      return buildFireGrid({ hotspots, regions: data.regions, context, horizonDays, nowMs: hotspotsAt, incompleteFeed })
    } catch {
      return null
    }
  }, [data, context, hotspots, hotspotsAt, hotspotsTruncated, hotspotsError, horizonDays])
  // Derivada: se a grade nova não tem mais a célula, a seleção some sozinha (sem efeito em laço).
  const selectedCell = useMemo<FireCell | null>(
    () => (grid && selectedCellId ? (grid.cells.find((cell) => cell.id === selectedCellId) ?? null) : null),
    [grid, selectedCellId],
  )

  function chooseRegion(id: string) {
    setRegionId(id)
    setPolygon(null)
  }

  const meta = data?.meta
  const versions = { method: meta?.methodVersion ?? '', dataset: meta?.datasetVersion ?? '' }
  const baselineLabel = meta ? `${meta.baselineFrom}–${meta.baselineTo}` : ''
  const firstYear = data?.years[0]
  const place = polygon ? 'recorte' : (region?.id ?? 'area')
  const caption = !calendar || !region || !meta
    ? ''
    : calendar.mode === 'empty'
      ? t('panelNoIntersection')
      : calendar.mode === 'polygon'
        ? t('panelCaptionPolygon', { version: meta.methodVersion })
        : t('panelCaptionRegion', { region: region.name, version: meta.methodVersion })
  const calendarEmpty = meta
    ? meta.periodStart
      ? t('panelCalendarEmpty', { coverage: coverageLabel(meta, text) })
      : t('panelCalendarEmptyNoCoverage')
    : ''
  // Monta, só ao clicar no "?", o contexto explicável do dado. No polígono, o "E se?" recalcula a janela de referência.
  const explainFor =
    (build: (explainData: ExplainData) => ExplainContext, labelVars?: Vars) => (): ExplainPayload | null => {
      if (!data || !region || !calendar || !board || !context) return null
      // Polígono sem sobreposição: nada a explicar (a região antes selecionada não vale aqui).
      if (polygon && calendar.mode !== 'polygon') return null
      const explainData: ExplainData = {
        meta: data.meta,
        years: data.years,
        months: text.monthShort,
        currentYear: data.meta.currentYear,
        baseline: context.baseline,
        dashboard: board,
        region,
        calendar,
        regions: data.regions,
        polygonActive: polygon !== null,
      }
      return {
        context: build(explainData),
        labelVars,
        whatIf: polygon
          ? polygonRunner({ regions: data.regions, years: data.years, polygon, context, hotspotInside: insideHotspots.length, text })
          : undefined,
      }
    }
  const hotspotsErrorText = hotspotsError === null ? null : errorText(hotspotsError, t, 'panelErrHotspots')
  const disclaimer = data?.disclaimer || t('panelDisclaimerFallback')

  const explainOff = polygon && calendar && calendar.mode !== 'polygon' ? t('explainNoOverlap') : null

  return (
    <ExplainProvider disabledReason={explainOff}>
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#top">
          <img src="/logo.png" alt="" aria-hidden="true" width="32" height="24" className="brand-mark" />
          <span>{t('appName')}</span>
        </a>
        <nav className="nav" aria-label={t('panelNavAria')}>
          {NAV.map((item) => (
            <a
              key={item.hash}
              className={`nav-item${section === item.hash ? ' active' : ''}`}
              href={item.hash}
              aria-current={section === item.hash ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {t(item.label)}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sensor-mini">
            <span><i className="sensor-dot modis" />MODIS</span>
            <span><i className="sensor-dot viirs" />VIIRS</span>
          </div>
        </div>
      </aside>

      <main id="top">
        <header className="topbar">
          <div className="topbar-title">
            <p className="eyebrow">{t('panelEyebrow')}{firstYear && meta ? ` · ${firstYear}—${meta.currentYear}` : ''}</p>
            <h1>{t('panelTitle')}</h1>
            <p className="sub">{t('panelSub')}</p>
          </div>
          <div className="top-actions">
            <a className="btn ghost" href="/">{t('panelBackHome')}</a>
            <div className="segmented small" role="group" aria-label={t('language')}>
              {LOCALES.map((code: Locale) => (
                <button
                  key={code}
                  type="button"
                  className={locale === code ? 'active' : undefined}
                  aria-pressed={locale === code}
                  title={code === 'pt-BR' ? t('languagePt') : t('languageEn')}
                  onClick={() => setLocale(code)}
                >
                  {code === 'pt-BR' ? 'PT' : 'EN'}
                </button>
              ))}
            </div>
            <button className="btn ghost" type="button" onClick={() => tableRef.current?.showModal()}>{t('panelAccessibleTable')}</button>
            <button
              className="btn primary"
              type="button"
              disabled={!calendar || !board}
              onClick={() => {
                if (!data || !calendar || !board) return
                download(`carcara-orbit_${place}_calendario.csv`, calendarCsv(calendar, data.years, board.name, board.biome, versions))
              }}
            >
              {t('panelExportCsv')}
            </button>
          </div>
        </header>

        {error !== null && (
          <p className="banner" role="alert">
            <span>{errorText(error, t)}</span>
            <button className="btn" type="button" onClick={() => setShellAttempt((attempt) => attempt + 1)}>{t('panelRetry')}</button>
          </p>
        )}
        {loading && !data && <p className="banner" role="status">{t('panelLoadingCalendar')}</p>}

        {data && region && calendar && board && (
          <>
            <section className="filters" aria-label={t('panelFiltersAria')}>
              <div className="chips" role="group" aria-label={t('panelRegionGroupAria')}>
                {data.regions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={!polygon && item.id === region.id ? 'chip active' : 'chip'}
                    aria-pressed={!polygon && item.id === region.id}
                    style={{ '--c': item.color } as CSSProperties}
                    onClick={() => chooseRegion(item.id)}
                    title={hasData(item) ? undefined : t('panelNoHotspotsLoaded')}
                  >
                    <i />{item.name}
                  </button>
                ))}
              </div>
              <div className="segmented small" role="group" aria-label={t('panelPeriodAria')}>
                <button type="button" className={period === 'all' ? 'active' : undefined} aria-pressed={period === 'all'} onClick={() => setPeriod('all')}>{t('panelFullSeries')}</button>
                <button type="button" className={period === '10' ? 'active' : undefined} aria-pressed={period === '10'} onClick={() => setPeriod('10')}>{t('panelLast10')}</button>
              </div>
            </section>

            <section className="kpis" aria-label={t('panelKpisAria')}>
              <Kpi
                label={t('panelKpiCount', { year: board.currentYear })}
                value={board.currentTotal === null ? null : formatCount(board.currentTotal, locale)}
                unit={t('panelUnitHotspots')}
                foot={currentYearFoot(board.currentMonths, board.currentMonthsLabel, t)}
                delta={board.currentAnomaly === null ? null : `${signed(board.currentAnomaly, locale)}%`}
                emptyDelta={t('panelNoReference')}
                up={board.currentAnomaly !== null && board.currentAnomaly >= 0}
                accent="var(--ember)"
                emptyText={t('noData')}
                explain={<ExplainButton label={t('panelKpiCount', { year: board.currentYear })} build={explainFor(explainCount, { year: board.currentYear })} />}
              />
              <Kpi
                label={t('panelKpiAnomaly', { year: board.currentYear })}
                value={board.currentAnomaly === null ? null : `${signed(board.currentAnomaly, locale)}%`}
                foot={board.currentAnomaly === null ? t('panelNoRefYears', { baseline: baselineLabel }) : t('panelVsAverageShort', { baseline: baselineLabel })}
                delta={board.currentAnomaly === null ? null : board.currentAnomaly >= 0 ? t('panelAbove') : t('panelBelow')}
                up={board.currentAnomaly !== null && board.currentAnomaly >= 0}
                accent="var(--amber)"
                emptyText={t('noData')}
                explain={<ExplainButton label={t('panelKpiAnomaly', { year: board.currentYear })} build={explainFor(explainAnomaly, { year: board.currentYear })} />}
              />
              <Kpi
                label={t('panelKpiPeak')}
                value={board.peakYear === null ? null : String(board.peakYear)}
                foot={board.peakTotal === null ? t('panelNoFullYear', { baseline: baselineLabel }) : t('panelPeakFoot', { total: formatCount(board.peakTotal, locale) })}
                delta={board.peakYear === null ? null : t('panelMaximum')}
                neutral
                accent="var(--danger)"
                emptyText={t('noData')}
                explain={<ExplainButton label={t('panelKpiPeak')} build={explainFor(explainPeak)} />}
              />
              <Kpi
                label={t('panelKpiTrend')}
                value={board.trend === null ? null : `${signed(board.trend, locale)}%`}
                unit={board.trend === null ? undefined : t('panelPerDecade')}
                foot={board.trend === null ? t('panelFewYears', { window: board.trendWindow }) : t('panelTrendFoot', { window: board.trendWindow })}
                delta={board.trend === null ? null : board.trend >= 0 ? t('panelRising') : t('panelFalling')}
                up={board.trend !== null && board.trend >= 0}
                accent="var(--teal)"
                emptyText={t('noData')}
                explain={<ExplainButton label={t('panelKpiTrend')} build={explainFor(explainTrend)} />}
              />
            </section>

            <section className="grid-main">
              <ActivityCalendar
                years={data.years}
                months={text.monthShort}
                calendar={calendar}
                caption={caption}
                period={period}
                currentYear={data.meta.currentYear}
                baselineLabel={baselineLabel}
                emptyMessage={calendarEmpty}
                explainCell={(yearIndex, month) => explainFor((explainData) => explainCalendarCell(explainData, data.years[yearIndex], month))}
              />
              <aside className="side-col">
                <article className="card insights-card">
                  <header className="card-head"><h2>{t('panelQuickRead')}</h2><span className="tag">{board.name}</span></header>
                  <ul className="insights">{board.insights.map((line) => <li key={line}>{line}</li>)}</ul>
                  <div className="confidence"><span>{t('panelConfidenceLabel')}</span><strong>{board.confidence ? levelLabel(board.confidence, t) : t('panelNotInformed')}</strong><ExplainButton label={t('panelConfidenceLabel')} build={explainFor(explainConfidence)} /></div>
                </article>
                <article className="card sensor-card">
                  <header className="card-head"><h2>{t('panelComposition')}</h2><ExplainButton label={t('panelComposition')} build={explainFor(explainSensorMix)} /></header>
                  <div className="sensor-body">
                    <div className="donut" style={{ '--modis': board.modisPct, '--viirs': board.viirsPct } as CSSProperties} role="img" aria-label={t('panelDonutAria', { modis: board.modisPct.toFixed(1), viirs: board.viirsPct.toFixed(1) })}>
                      <div className="donut-center"><strong>{formatCount(board.modisRaw + board.viirsRaw, locale)}</strong><span>{t('panelRawHotspots')}</span></div>
                    </div>
                    <ul className="sensor-legend">
                      <li><i className="sensor-dot modis" /><span>MODIS</span><strong>{board.modisPct.toLocaleString(locale, { maximumFractionDigits: 1 })}%</strong></li>
                      <li><i className="sensor-dot viirs" /><span>VIIRS</span><strong>{board.viirsPct.toLocaleString(locale, { maximumFractionDigits: 1 })}%</strong></li>
                    </ul>
                  </div>
                  <p className="sensor-note">{t('panelSensorNote')}</p>
                </article>
                <article className="card method-card" id="methodology">
                  <header className="card-head"><h2>{t('panelMethod')}</h2><div className="card-head-actions"><span className="tag mono">{data.meta.methodVersion}</span><ExplainButton label={t('panelMethod')} build={explainFor(explainMethodFactor)} /></div></header>
                  <dl className="method-list">
                    <div><dt>{t('panelCalibrationWindow')}</dt><dd>{data.meta.calibrationWindow || '—'}</dd></div>
                    <div><dt>{t('panelRegionalFactor')}</dt><dd>×{board.factor.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
                    <div><dt>{t('panelUncertaintyEstimate')}</dt><dd>{board.uncertainty === null ? '—' : `±${Math.round(board.uncertainty)}%`}</dd></div>
                    <div><dt>{t('panelBaseline')}</dt><dd>{baselineLabel}</dd></div>
                  </dl>
                  {calibrationFallback(data.meta) && (
                    <p className="sensor-note">{t('panelCalibrationFallback')}</p>
                  )}
                  <button className="link" type="button" onClick={() => methodRef.current?.showModal()}>{t('panelHowItWorks')}</button>
                </article>
              </aside>
            </section>

            <section className="grid-charts" id="series">
              <article className="card chart-card">
                <header className="card-head">
                  <div><h2>{t('panelClimatologyTitle')}</h2><p>{t('panelClimatologySub')}</p></div>
                  <div className="card-head-actions">
                    <span className="tag">{board.peakMonthLabel === '—' ? t('panelNoPeakRef') : t('panelPeakIn', { month: board.peakMonthLabel })}</span>
                    <ExplainButton label={t('panelClimatologyTitle')} build={explainFor((explainData) => explainClimatology(explainData))} />
                  </div>
                </header>
                <div className="chart"><ClimatologyChart climatology={board.climatology} current={board.currentMonths} currentYear={board.currentYear} baselineLabel={baselineLabel} /></div>
              </article>
              <article className="card chart-card">
                <header className="card-head">
                  <div><h2>{t('panelAnnualTitle')}</h2><p>{t('panelAnnualSub')}</p></div>
                  <div className="card-head-actions">
                    <span className={board.trend !== null && board.trend >= 0 ? 'tag warm' : 'tag'}>{board.trend === null ? t('panelNoTrendShort') : t('panelPerDecadeValue', { value: `${signed(board.trend, locale)}%` })}</span>
                    <ExplainButton label={t('panelAnnualTitle')} build={explainFor((explainData) => explainAnnual(explainData))} />
                  </div>
                </header>
                <div className="chart"><AnnualChart annual={board.annual} baseline={board.baselineAnnual} baselineLabel={baselineLabel} /></div>
              </article>
            </section>

            {/* Mapa logo acima da calculadora: clicar numa área acesa atualiza o bloco "Local selecionado" logo abaixo. */}
            <section className="grid-bottom">
              <FireMap3D
                regions={data.regions}
                hotspots={hotspots}
                polygon={polygon}
                focusRing={region.ring}
                emphasisRegionId={polygon ? null : region.id}
                calendar={calendar}
                hotspotsLoading={hotspotsLoading}
                hotspotsError={hotspotsErrorText}
                onRetryHotspots={() => setPointsAttempt((attempt) => attempt + 1)}
                onPolygonChange={setPolygon}
                hotspotWindowLabel={hotspotWindowLabel}
                grid={grid}
                gridLoading={hotspotsLoading}
                horizonDays={horizonDays}
                onHorizonChange={setHorizonDays}
                selectedCellId={selectedCell?.id ?? null}
                onCellSelect={(cell) => setSelectedCellId(cell?.id ?? null)}
              />
              <article className="card export-card">
                <header className="card-head"><h2>{t('panelExportTitle')}</h2></header>
                <p>{t('panelExportLead')}</p>
                <ul className="file-list">
                  <li>
                    <span className="file-ico">CSV</span>
                    <div><strong>{t('panelExportCalendar')}</strong><small>{board.name}</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_calendario.csv`, calendarCsv(calendar, data.years, board.name, board.biome, versions))}>{t('panelDownload')}</button>
                  </li>
                  <li>
                    <span className="file-ico">CSV</span>
                    <div><strong>{t('panelExportHotspots')}</strong><small>{t('panelPoints', { count: formatCount(insideHotspots.length, locale) })}</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_focos.csv`, hotspotCsv(insideHotspots, versions))}>{t('panelDownload')}</button>
                  </li>
                  {grid && (
                    <li>
                      <span className="file-ico">CSV</span>
                      <div><strong>{t('exportGridTitle')}</strong><small>{t('exportGridSub', { count: formatCount(grid.cells.length, locale), days: grid.horizonDays })}</small></div>
                      <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_grade-chance_${grid.horizonDays}d.csv`, gridCsv(grid, data.regions, versions))}>{t('panelDownload')}</button>
                    </li>
                  )}
                  <li>
                    <span className="file-ico">GEO</span>
                    <div><strong>{t('panelAreaOfInterest')}</strong><small>{polygon ? t('panelDrawnPolygon') : region.name}</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_aoi.geojson`, areaGeoJson(polygon ?? region.ring, board.name, versions), 'application/geo+json')}>{t('panelDownload')}</button>
                  </li>
                </ul>
                <div className="export-foot"><span className="mono">{data.meta.methodVersion}</span><span>{modeLabel(data.meta, t)}</span></div>
              </article>
            </section>

            <RiskCalculator
              regions={data.regions}
              initialRegionId={region.id}
              context={context ?? { currentYear: data.meta.currentYear, baseline: { from: data.meta.baselineFrom, to: data.meta.baselineTo } }}
              methodVersion={data.meta.methodVersion}
              meta={data.meta}
              selectedCell={selectedCell}
              grid={grid}
              onClearCell={() => setSelectedCellId(null)}
            />


            <footer className="page-foot">
              <img src="/favicon.svg" alt="" width="28" height="28" />
              <p><strong>{t('appName')}</strong> · {disclaimer} {t('panelFooterSource')}</p>
            </footer>

            <dialog ref={tableRef} className="table-dialog" onClose={() => tableRef.current?.close()}>
              <header>
                <div><h2>{t('panelAccessibleTable')}</h2><p>{t('panelTableSub', { name: board.name })}</p></div>
                <button className="btn ghost" type="button" onClick={() => tableRef.current?.close()}>{t('panelClose')}</button>
              </header>
              <div className="table-scroll">
                <table>
                  <caption className="sr">{t('panelTableCaption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('year')}</th>
                      {text.monthShort.map((month) => <th key={month} scope="col">{month}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.years.map((year, yearIndex) => (
                      <tr key={year}>
                        <th scope="row">{year}</th>
                        {calendar.counts[yearIndex].map((value, month) => (
                          <td key={month} title={value === null ? t('noData') : calendar.anomaly[yearIndex][month] === null ? t('panelNoReference') : signed(calendar.anomaly[yearIndex][month] ?? 0, locale) + '%'}>
                            {value === null ? t('noData') : formatCount(value, locale)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </dialog>

            <dialog ref={methodRef} className="method-dialog">
              <header>
                <div><h2>{t('panelHarmonizationTitle')}</h2><p>{t('panelVersionLine', { version: data.meta.methodVersion, mode: modeLabel(data.meta, t) })}</p></div>
                <button className="btn ghost" type="button" onClick={() => methodRef.current?.close()}>{t('panelClose')}</button>
              </header>
              <div className="method-prose">
                <ol>
                  <li><strong>{t('panelStepIngestLabel')}.</strong> {t('panelStepIngestBody')}</li>
                  <li><strong>{t('panelStepCleanLabel')}.</strong> {t('panelStepCleanBody')}</li>
                  <li><strong>{t('panelStepAggLabel')}.</strong> {t('panelStepAggBody')}</li>
                  <li><strong>{t('panelStepCalLabel')}.</strong> {t('panelStepCalBody', { window: data.meta.calibrationWindow || t('panelCalibrationWindowFallback') })}</li>
                  <li><strong>{t('panelStepSeriesLabel')}.</strong> {t('panelStepSeriesBody', { baseline: baselineLabel })}</li>
                </ol>
                <p className="warn">{disclaimer}</p>
              </div>
            </dialog>
          </>
        )}
      </main>
    </div>
    </ExplainProvider>
  )
}

type KpiProps = {
  label: string
  /** null = sem dado. Mostra "—" e esconde a unidade e o delta, em vez de um zero falso. */
  value: string | null
  unit?: string
  foot: string
  delta: string | null
  /** Texto do selo quando delta é null. */
  emptyDelta?: string
  /** Texto para acessibilidade quando value é null. */
  emptyText?: string
  up?: boolean
  neutral?: boolean
  accent: string
  /** Botão "?" do dado (fora do texto do rótulo, nunca dentro de outro controle). */
  explain?: ReactNode
}

function Kpi({ label, value, unit, foot, delta, emptyDelta, emptyText = '', up, neutral, accent, explain }: KpiProps) {
  const direction = neutral ? 'neutral' : up ? 'up' : 'down'
  return (
    <article className="kpi" style={{ '--accent': accent } as CSSProperties}>
      <div className="kpi-label"><span>{label}</span>{explain}</div>
      <div className="kpi-value">
        {value === null ? <span aria-label={emptyText}>—</span> : value}
        {value !== null && unit && <small>{unit}</small>}
      </div>
      <div className="kpi-foot">
        {delta === null ? <span className="delta neutral">{emptyDelta ?? emptyText}</span> : <span className={`delta ${direction}`}>{delta}</span>}
        <span>{foot}</span>
      </div>
    </article>
  )
}

function currentYearFoot(months: (number | null)[], label: string, t: Translate): string {
  const known = months.filter((value) => value !== null && value !== undefined).length
  if (known === 0) return t('panelNoDataYear')
  return known < 12 ? t('panelPartialYearLabel', { label }) : label
}

function hasData(region: RegionSeries): boolean {
  return region.counts.some((row) => row.some((value) => value !== null))
}

function knownCells(region: RegionSeries): number {
  return region.counts.reduce((sum, row) => sum + row.filter((value) => value !== null).length, 0)
}

/** Região inicial: a que tem mais meses com dado; empate fica com a primeira da lista. */
function defaultRegionId(regions: RegionSeries[]): string | null {
  let best: RegionSeries | null = null
  for (const region of regions) {
    if (best === null || knownCells(region) > knownCells(best)) best = region
  }
  return best?.id ?? null
}

function monthYear(value: string, names: string[]): string {
  const [year, month] = value.split('-')
  const label = names[Number(month) - 1]
  return label ? `${label}/${year}` : value
}

function coverageLabel(meta: DatasetMeta, text: PanelText): string {
  if (!meta.periodStart || !meta.periodEnd) return ''
  const start = monthYear(meta.periodStart, text.monthShort)
  const end = monthYear(meta.periodEnd, text.monthShort)
  return start === end ? start : `${start}–${end}`
}

function modeLabel(meta: DatasetMeta, t: Translate): string {
  if (meta.mode === 'mock') return t('panelModeMock')
  if (meta.mode === 'real') return t('panelModeReal')
  return t('panelModeUnknown')
}

function calibrationFallback(meta: DatasetMeta): boolean {
  return meta.warnings.some((warning) => /fell back to factor 1|sem sobreposição/i.test(warning))
}

function signed(value: number, locale: PanelText['locale']): string {
  const body = value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${value > 0 ? '+' : ''}${body}`
}

function Icon({ name }: { name: 'grid' | 'calendar' | 'map' | 'chart' | 'calc' | 'info' }) {
  const paths: Record<typeof name, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    calendar: 'M4 6h16v14H4zM4 10h16M8 4v4M16 4v4',
    map: 'M4 7l5-2 6 2 5-2v14l-5 2-6-2-5 2zM9 5v14M15 7v14',
    chart: 'M4 19V5M4 19h16M8 15l4-5 3 3 5-7',
    calc: 'M6 3h12v18H6zM9 7h6M9 11h2M13 11h2M9 15h2M13 15h2',
    info: 'M12 12a8 8 0 1 0 0 .01M12 11v5M12 8h.01',
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}
