import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ActivityCalendar } from './components/ActivityCalendar'
import { AnnualChart, ClimatologyChart } from './components/Charts'
import { PolygonMap } from './components/PolygonMap'
import { RiskCalculator } from './components/RiskCalculator'
import { loadHotspots, loadWorkspace } from './data/api'
import { dashboardForPolygon, dashboardForRegion } from './lib/dashboard'
import { areaGeoJson, calendarCsv, download, hotspotCsv } from './lib/exportData'
import { formatCount } from './lib/format'
import { pointInRing } from './lib/geo'
import { filterCalendar } from './lib/series'
import type { Hotspot, LonLat, Workspace } from './types'
import './App.css'

type Period = 'all' | '10'

const NAV = [
  { hash: '#topo', icon: 'grid', label: 'Visão geral' },
  { hash: '#calendario', icon: 'calendar', label: 'Calendário' },
  { hash: '#mapa', icon: 'map', label: 'Mapa de focos' },
  { hash: '#serie', icon: 'chart', label: 'Séries históricas' },
  { hash: '#calculadora', icon: 'calc', label: 'Calculadora' },
  { hash: '#metodo', icon: 'info', label: 'Metodologia' },
] as const

export default function App() {
  const [section, setSection] = useState<string>(() => window.location.hash || '#topo')
  useEffect(() => {
    const onHash = () => setSection(window.location.hash || '#topo')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [data, setData] = useState<Workspace | null>(null)
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hotspotsError, setHotspotsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [hotspotsLoading, setHotspotsLoading] = useState(true)
  const [regionId, setRegionId] = useState('pantanal')
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
        if (live) setData(workspace)
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Falha ao carregar a API.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [shellAttempt])

  useEffect(() => {
    let live = true
    setHotspotsLoading(true)
    setHotspotsError(null)
    loadHotspots()
      .then((points) => {
        if (live) setHotspots(points)
      })
      .catch((reason: unknown) => {
        if (!live) return
        setHotspots([])
        setHotspotsError(reason instanceof Error ? reason.message : 'Os focos não carregaram.')
      })
      .finally(() => {
        if (live) setHotspotsLoading(false)
      })
    return () => {
      live = false
    }
  }, [pointsAttempt])

  const region = data?.regions.find((item) => item.id === regionId) ?? data?.regions[0]
  const calendar = useMemo(
    () => (data && region ? filterCalendar(data.regions, data.years, polygon, region.id) : null),
    [data, polygon, region],
  )
  const insideHotspots = useMemo(() => {
    if (!region) return []
    if (polygon) return hotspots.filter((hotspot) => pointInRing(hotspot.lon, hotspot.lat, polygon))
    return hotspots.filter((hotspot) => hotspot.regionId === region.id)
  }, [hotspots, polygon, region])
  const board = useMemo(() => {
    if (!data || !region || !calendar) return null
    if (polygon) return dashboardForPolygon(calendar, data.years, data.regions, insideHotspots.length)
    return dashboardForRegion(region)
  }, [calendar, data, insideHotspots.length, polygon, region])

  function chooseRegion(id: string) {
    setRegionId(id)
    setPolygon(null)
  }

  const place = polygon ? 'recorte' : (region?.id ?? 'area')
  const caption = !calendar || !region
    ? ''
    : calendar.mode === 'empty'
      ? 'Sem interseção com a série harmonizada'
      : calendar.mode === 'polygon'
        ? 'Focos harmonizados ponderados pela área de cada bioma dentro do polígono · h1.0-mock'
        : `Focos harmonizados · ${region.name} · h1.0-mock`

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#topo">
          <img src="/logo.png" alt="" aria-hidden="true" width="32" height="24" className="brand-mark" />
          <span>Carcará Orbit</span>
        </a>
        <nav className="nav" aria-label="Navegação principal">
          {NAV.map((item) => (
            <a
              key={item.hash}
              className={`nav-item${section === item.hash ? ' active' : ''}`}
              href={item.hash}
              aria-current={section === item.hash ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="mock-badge"><span className="dot" />Dados mockados</div>
          <p>Protótipo para demonstração. Não usar para decisão operacional.</p>
          <div className="sensor-mini">
            <span><i className="sensor-dot modis" />MODIS</span>
            <span><i className="sensor-dot viirs" />VIIRS</span>
          </div>
        </div>
      </aside>

      <main id="topo">
        <header className="topbar">
          <div className="topbar-title">
            <p className="eyebrow">CALENDÁRIO HARMONIZADO · 2000—2026</p>
            <h1>Atividade de queimadas</h1>
            <p className="sub">MODIS e VIIRS em uma única série. O polígono no mapa recorta focos e calendário.</p>
          </div>
          <div className="top-actions">
            <button className="btn ghost" type="button" onClick={() => tableRef.current?.showModal()}>Tabela acessível</button>
            <button
              className="btn primary"
              type="button"
              disabled={!calendar || !board}
              onClick={() => {
                if (!data || !calendar || !board) return
                download(`carcara-orbit_${place}_calendario.csv`, calendarCsv(calendar, data.years, board.name, board.biome))
              }}
            >
              Exportar CSV
            </button>
          </div>
        </header>

        {error && (
          <p className="banner" role="alert">
            <span>{error}</span>
            <button className="btn" type="button" onClick={() => setShellAttempt((attempt) => attempt + 1)}>Tentar de novo</button>
          </p>
        )}
        {loading && !data && <p className="banner" role="status">Carregando calendário em /api…</p>}

        {data && region && calendar && board && (
          <>
            <section className="filters" aria-label="Filtros">
              <div className="chips" role="group" aria-label="Selecionar área de interesse">
                {data.regions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={!polygon && item.id === region.id ? 'chip active' : 'chip'}
                    aria-pressed={!polygon && item.id === region.id}
                    style={{ '--c': item.color } as CSSProperties}
                    onClick={() => chooseRegion(item.id)}
                  >
                    <i />{item.name}
                  </button>
                ))}
              </div>
              <div className="segmented small" role="group" aria-label="Período">
                <button type="button" className={period === 'all' ? 'active' : undefined} aria-pressed={period === 'all'} onClick={() => setPeriod('all')}>Série completa</button>
                <button type="button" className={period === '10' ? 'active' : undefined} aria-pressed={period === '10'} onClick={() => setPeriod('10')}>Últimos 10 anos</button>
              </div>
            </section>

            <section className="kpis" aria-label="Indicadores principais">
              <Kpi label="Focos em 2026" value={formatCount(board.currentTotal)} unit="focos" foot="jan–out · ano parcial" delta={signed(board.currentAnomaly) + '%'} up={board.currentAnomaly >= 0} accent="var(--ember)" />
              <Kpi label="Anomalia 2026" value={`${signed(board.currentAnomaly)}%`} foot="vs. média 2003–2025" delta={board.currentAnomaly >= 0 ? 'acima' : 'abaixo'} up={board.currentAnomaly >= 0} accent="var(--amber)" />
              <Kpi label="Pico histórico" value={String(board.peakYear)} foot={`${formatCount(board.peakTotal)} focos · ano completo`} delta="máximo" accent="var(--danger)" />
              <Kpi label="Tendência" value={`${signed(board.trend)}%`} unit="/década" foot={`${board.trendWindow} · regressão linear`} delta={board.trend >= 0 ? 'alta' : 'queda'} up={board.trend >= 0} accent="var(--teal)" />
            </section>

            <section className="grid-main">
              <ActivityCalendar years={data.years} months={data.months} calendar={calendar} caption={caption} period={period} />
              <aside className="side-col">
                <article className="card insights-card">
                  <header className="card-head"><h2>Leitura rápida</h2><span className="tag">{board.name}</span></header>
                  <ul className="insights">{board.insights.map((text) => <li key={text}>{text}</li>)}</ul>
                  <div className="confidence"><span>Confiança da harmonização</span><strong>{board.confidence}</strong></div>
                </article>
                <article className="card sensor-card">
                  <header className="card-head"><h2>Composição da série</h2></header>
                  <div className="sensor-body">
                    <div className="donut" style={{ '--modis': board.modisPct, '--viirs': board.viirsPct } as CSSProperties} role="img" aria-label={`MODIS ${board.modisPct.toFixed(1)}% e VIIRS ${board.viirsPct.toFixed(1)}%`}>
                      <div className="donut-center"><strong>{formatCount(board.modisRaw + board.viirsRaw)}</strong><span>focos brutos</span></div>
                    </div>
                    <ul className="sensor-legend">
                      <li><i className="sensor-dot modis" /><span>MODIS</span><strong>{board.modisPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</strong></li>
                      <li><i className="sensor-dot viirs" /><span>VIIRS</span><strong>{board.viirsPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</strong></li>
                    </ul>
                  </div>
                  <p className="sensor-note">A série harmonizada corrige a diferença de sensibilidade entre os sensores.</p>
                </article>
                <article className="card method-card" id="metodo">
                  <header className="card-head"><h2>Método</h2><span className="tag mono">h1.0</span></header>
                  <dl className="method-list">
                    <div><dt>Janela de calibração</dt><dd>2012—2025</dd></div>
                    <div><dt>Fator regional</dt><dd>×{board.factor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
                    <div><dt>Incerteza estimada</dt><dd>±{Math.round(board.uncertainty)}%</dd></div>
                    <div><dt>Baseline</dt><dd>2003—2025</dd></div>
                  </dl>
                  <button className="link" type="button" onClick={() => methodRef.current?.showModal()}>Como funciona a harmonização</button>
                </article>
              </aside>
            </section>

            <section className="grid-charts" id="serie">
              <article className="card chart-card">
                <header className="card-head">
                  <div><h2>Climatologia mensal</h2><p>Média histórica e faixa de variabilidade</p></div>
                  <span className="tag">Pico em {board.peakMonthLabel}</span>
                </header>
                <div className="chart"><ClimatologyChart climatology={board.climatology} current={board.currentMonths} /></div>
              </article>
              <article className="card chart-card">
                <header className="card-head">
                  <div><h2>Série anual</h2><p>Total harmonizado por ano</p></div>
                  <span className={board.trend >= 0 ? 'tag warm' : 'tag'}>{signed(board.trend)}%/década</span>
                </header>
                <div className="chart"><AnnualChart annual={board.annual} baseline={board.baselineAnnual} /></div>
              </article>
            </section>

            <RiskCalculator regions={data.regions} years={data.years} initialRegionId={region.id} />

            <section className="grid-bottom">
              <PolygonMap
                regions={data.regions}
                hotspots={hotspots}
                polygon={polygon}
                focusRing={region.ring}
                emphasisRegionId={polygon ? null : region.id}
                calendar={calendar}
                hotspotsLoading={hotspotsLoading}
                hotspotsError={hotspotsError}
                onRetryHotspots={() => setPointsAttempt((attempt) => attempt + 1)}
                onPolygonChange={setPolygon}
              />
              <article className="card export-card">
                <header className="card-head"><h2>Leve os dados</h2></header>
                <p>Baixe o recorte atual. Meses sem dado ficam de fora e não viram zero.</p>
                <ul className="file-list">
                  <li>
                    <span className="file-ico">CSV</span>
                    <div><strong>Calendário mensal</strong><small>{board.name}</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_calendario.csv`, calendarCsv(calendar, data.years, board.name, board.biome))}>Baixar</button>
                  </li>
                  <li>
                    <span className="file-ico">CSV</span>
                    <div><strong>Focos do recorte</strong><small>{insideHotspots.length.toLocaleString('pt-BR')} pontos</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_focos.csv`, hotspotCsv(insideHotspots))}>Baixar</button>
                  </li>
                  <li>
                    <span className="file-ico">GEO</span>
                    <div><strong>Área de interesse</strong><small>{polygon ? 'polígono desenhado' : region.name}</small></div>
                    <button className="mini-btn" type="button" onClick={() => download(`carcara-orbit_${place}_aoi.geojson`, areaGeoJson(polygon ?? region.ring, board.name), 'application/geo+json')}>Baixar</button>
                  </li>
                </ul>
                <div className="export-foot"><span className="mono">h1.0-mock</span><span>Dados sintéticos</span></div>
              </article>
            </section>

            <footer className="page-foot">
              <img src="/favicon.svg" alt="" width="28" height="28" />
              <p><strong>Carcará Orbit</strong> · {data.disclaimer} Fontes dos dados reais: NASA FIRMS / Earthdata (MODIS C6.1 e VIIRS 375 m).</p>
            </footer>

            <dialog ref={tableRef} className="table-dialog" onClose={() => tableRef.current?.close()}>
              <header>
                <div><h2>Tabela acessível</h2><p>{board.name} · contagem harmonizada</p></div>
                <button className="btn ghost" type="button" onClick={() => tableRef.current?.close()}>Fechar</button>
              </header>
              <div className="table-scroll">
                <table>
                  <caption className="sr">Contagem harmonizada por ano e mês</caption>
                  <thead>
                    <tr>
                      <th scope="col">Ano</th>
                      {data.months.map((month) => <th key={month} scope="col">{month}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.years.map((year, yearIndex) => (
                      <tr key={year}>
                        <th scope="row">{year}</th>
                        {calendar.counts[yearIndex].map((value, month) => (
                          <td key={month} title={calendar.anomaly[yearIndex][month] === null ? 'sem dado' : signed(calendar.anomaly[yearIndex][month] ?? 0) + '%'}>
                            {value === null ? 'sem dado' : formatCount(value)}
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
                <div><h2>Harmonização</h2><p>Versão h1.0-mock · dados sintéticos</p></div>
                <button className="btn ghost" type="button" onClick={() => methodRef.current?.close()}>Fechar</button>
              </header>
              <div className="method-prose">
                <ol>
                  <li><strong>Ingestão.</strong> Focos MODIS C6.1 e VIIRS 375 m.</li>
                  <li><strong>Limpeza.</strong> Baixa confiança, nuvem, borda e duplicata do mesmo sobrevoo saem da contagem.</li>
                  <li><strong>Agregação.</strong> Grade de 0,1° e contagem por cluster.</li>
                  <li><strong>Calibração.</strong> Na janela 2012–2025, o fator é a mediana de VIIRS sobre MODIS, por bioma e mês.</li>
                  <li><strong>Série.</strong> A contagem exibida é a harmonizada. A anomalia compara com a média de 2003–2025 do mesmo mês.</li>
                </ol>
                <p className="warn">{data.disclaimer}</p>
              </div>
            </dialog>
          </>
        )}
      </main>
    </div>
  )
}

function Kpi({ label, value, unit, foot, delta, up, accent }: { label: string; value: string; unit?: string; foot: string; delta: string; up?: boolean; accent: string }) {
  const direction = delta === 'máximo' ? 'neutral' : up ? 'up' : 'down'
  return (
    <article className="kpi" style={{ '--accent': accent } as CSSProperties}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}{unit && <small>{unit}</small>}</div>
      <div className="kpi-foot"><span className={`delta ${direction}`}>{delta}</span><span>{foot}</span></div>
    </article>
  )
}

function signed(value: number): string {
  const body = value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
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
