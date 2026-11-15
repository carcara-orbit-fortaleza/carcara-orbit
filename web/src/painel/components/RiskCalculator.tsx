import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type ReactNode, type Ref } from 'react'
import { DEFAULT_INPUTS, MIN_REFERENCE_YEARS, forecastRegion, overviewRegions, type CalcInputs, type ForecastContext } from '../lib/forecast'
import type { FireCell, FireGrid } from '../lib/fireGrid'
import { formatArea, formatChance, formatCount, formatLatLon, formatShare } from '../lib/format'
import { levelLabel, usePanelText, type PanelText, type Translate } from '../lib/panelText'
import type { MessageKey } from '../../i18n/messages'
import { ExplainButton } from '../explain/ExplainButton'
import { explainForecastYear, explainPostPlan } from '../explain/builders'
import { forecastRunner } from '../explain/whatifAdapters'
import type { DatasetMeta, RegionSeries } from '../types'

type Props = {
  regions: RegionSeries[]
  initialRegionId: string
  context: ForecastContext
  methodVersion: string
  /** Metadados do dataset: alimentam a origem e as ressalvas do "?". */
  meta: DatasetMeta | null
  /** Célula escolhida no mapa 3D; null mostra só a dica de clicar numa área acesa do mapa. */
  selectedCell?: FireCell | null
  /** Grade de onde a célula saiu: horizonte, confiança, ressalvas e resumo da região. */
  grid?: FireGrid | null
  onClearCell?: () => void
}

// Ressalvas conhecidas da grade (ver GRID_CAVEATS); chave desconhecida é ignorada.
const CAVEAT_KEYS: Record<string, MessageKey> = {
  'short-window': 'fireMapCaveatShortWindow',
  'no-seasonality': 'fireMapCaveatNoSeasonality',
  'no-hotspots': 'fireMapCaveatNoHotspots',
  'incomplete-feed': 'fireMapCaveatIncompleteFeed',
  'not-calibrated': 'fireMapCaveatNotCalibrated',
}

const HORIZONS = [1, 3, 5, 10]

export function RiskCalculator({ regions, initialRegionId, context, methodVersion, meta, selectedCell = null, grid = null, onClearCell }: Props) {
  const text = usePanelText()
  const { t, locale } = text
  const [regionId, setRegionId] = useState(initialRegionId)
  const [inputs, setInputs] = useState<CalcInputs>(DEFAULT_INPUTS)
  const localRef = useRef<HTMLElement>(null)

  // Ao escolher outra célula no mapa, a calculadora passa para a região dela. Ajuste feito na
  // renderização, só quando o id muda: depois disso o usuário pode trocar a região à vontade.
  const cellId = selectedCell?.id ?? null
  const [syncedCellId, setSyncedCellId] = useState<string | null>(cellId)
  if (cellId !== syncedCellId) {
    setSyncedCellId(cellId)
    if (selectedCell && selectedCell.regionId !== regionId && regions.some((item) => item.id === selectedCell.regionId)) {
      setRegionId(selectedCell.regionId)
    }
  }

  // Célula nova fora da tela: rola até o bloco do local, suave só sem prefers-reduced-motion.
  useEffect(() => {
    const block = localRef.current
    if (cellId === null || !block) return
    const rect = block.getBoundingClientRect()
    // No celular a barra de abas fixa no rodapé cobre o fim da tela: ela não conta como visível.
    const viewport = (window.innerHeight || document.documentElement.clientHeight) - fixedBottomBarHeight()
    if (rect.top >= 0 && rect.bottom <= viewport) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    block.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' })
  }, [cellId])

  const region = regions.find((item) => item.id === regionId) ?? regions[0]
  const forecast = useMemo(
    () => (region ? forecastRegion(region, inputs, context) : null),
    [region, inputs, context],
  )
  const overview = useMemo(() => overviewRegions(regions, inputs, context), [regions, inputs, context])
  const baselineLabel = `${context.baseline.from}–${context.baseline.to}`

  const explainOptions = { meta }
  const brl = (value: number) => value.toLocaleString(locale, { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
  const minutes = (value: number | null) => (value === null ? '—' : t('panelMinutes', { value: Math.round(value) }))
  const years = (count: number) => yearsText(count, t)

  // O ranking cobre todas as regiões e marca cada uma sem histórico; aparece mesmo
  // quando a região escolhida não tem dado suficiente.
  const rankingCard = (
      <article className="card">
        <header className="card-head"><div><h3>{t('panelRankTitle')}</h3><p>{t('panelRankSub')}</p></div></header>
        <ol className="calc-rank">
          {overview.map((item) => (
            <li key={item.id}>
              <i style={{ background: item.color }} aria-hidden="true" />
              <span>{item.name}</span>
              <small>{formatArea(item.areaKm2, locale)}</small>
              <strong>{item.sufficient ? formatShare(item.chanceAboveAlert, locale) : '—'}</strong>
              <small>{item.sufficient ? t('panelHotspotsCount', { count: formatCount(item.expectedNext, locale) }) : t('panelInsufficient')}</small>
            </li>
          ))}
        </ol>
      </article>
  )

  function setNumber(key: keyof CalcInputs) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value)
      setInputs((current) => ({ ...current, [key]: Number.isFinite(value) ? value : 0 }))
    }
  }

  if (!region || !forecast) return null

  const localBlock = selectedCell ? (
    <SelectedPlace ref={localRef} cell={selectedCell} grid={grid} regions={regions} text={text} onClear={onClearCell} />
  ) : (
    <p className="calc-local-hint">{t('calcLocalHint')}</p>
  )

  const statExplain = (label: string) => (
    <ExplainButton label={label} build={() => ({ context: explainPostPlan(region, inputs, context, explainOptions) })} />
  )
  const maxMonthly = Math.max(1, ...forecast.months.map((month) => month.expected))

  return (
    <section className="calc-section" id="calculator" aria-labelledby="calc-title">
      <header className="calc-head">
        <div>
          <p className="eyebrow">{t('panelCalcEyebrow')}</p>
          <h2 id="calc-title">{t('panelCalcTitle')}</h2>
          <p className="sub">{t('panelCalcLead')}</p>
        </div>
        <span className="tag mono">{methodVersion}</span>
      </header>

      {localBlock}

      <div className="calc-grid">
        <form className="card calc-form" onSubmit={(event) => event.preventDefault()} aria-label={t('panelCalcFormAria')}>
          <header className="card-head"><h3>{t('panelAssumptions')}</h3></header>

          <fieldset className="calc-field">
            <legend>{t('panelWhere')}</legend>
            <label>
              {t('panelAreaOfInterest')}
              <select value={region.id} onChange={(event) => setRegionId(event.target.value)}>
                {regions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </fieldset>

          <fieldset className="calc-field">
            <legend>{t('panelWhen')}</legend>
            <div className="segmented small" role="group" aria-label={t('panelHorizonAria')}>
              {HORIZONS.map((horizon) => (
                <button
                  key={horizon}
                  type="button"
                  className={inputs.horizonYears === horizon ? 'active' : undefined}
                  aria-pressed={inputs.horizonYears === horizon}
                  onClick={() => setInputs((current) => ({ ...current, horizonYears: horizon }))}
                >
                  {years(horizon)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="calc-field">
            <legend>{t('panelPosts')}</legend>
            <label>
              {t('panelPostsExisting')}
              <input type="number" min={0} step={1} value={inputs.existingPosts} onChange={setNumber('existingPosts')} />
            </label>
            <label>
              {t('panelCoverageRadius')}
              <input type="number" min={1} step={5} value={inputs.coverageRadiusKm} onChange={setNumber('coverageRadiusKm')} />
            </label>
            <label>
              {t('panelTravelSpeed')}
              <input type="number" min={1} step={5} value={inputs.travelSpeedKmh} onChange={setNumber('travelSpeedKmh')} />
            </label>
            <label>
              {t('panelFocusesPerPost')}
              <input type="number" min={1} step={5} value={inputs.focusesPerPostMonth} onChange={setNumber('focusesPerPostMonth')} />
            </label>
          </fieldset>

          <fieldset className="calc-field">
            <legend>{t('panelCost')}</legend>
            <label>
              {t('panelPostCost')}
              <input type="number" min={0} step={10000} value={inputs.postCostPerYear} onChange={setNumber('postCostPerYear')} />
            </label>
            <label>
              {t('panelCostPerFocus')}
              <input type="number" min={0} step={100} value={inputs.costPerAvoidedFocus} onChange={setNumber('costPerAvoidedFocus')} />
            </label>
            <label>
              {t('panelTargetReduction')}
              <input type="number" min={0} max={100} step={5} value={inputs.targetReductionPct} onChange={setNumber('targetReductionPct')} />
            </label>
          </fieldset>
        </form>

        {!forecast.sufficient ? (
          <div className="calc-results">
            <article className="card" role="status">
              <header className="card-head"><h3>{t('panelInsufficientTitle', { region: region.name })}</h3></header>
              <p className="sensor-note">
                {t('panelInsufficientBody', { min: MIN_REFERENCE_YEARS, baseline: baselineLabel, years: years(forecast.sampleYears) })}
              </p>
              <p className="sensor-note">
                {t('panelLoadHistoryBefore')}<code>npm run bootstrap</code>{t('panelLoadHistoryAfter')}
              </p>
            </article>
            {rankingCard}
          </div>
        ) : (
        <div className="calc-results">
          <article className="card">
            <header className="card-head">
              <div><h3>{t('panelProjectionTitle', { region: region.name })}</h3><p>{t('panelProjectionSub')}</p></div>
              <span className="tag">{t('panelReferenceYears', { count: forecast.sampleYears })}</span>
            </header>
            <div className="table-scroll">
              <table className="calc-table">
                <caption className="sr">{t('panelProjectionCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('year')}</th>
                    <th scope="col">{t('panelExpected')}</th>
                    <th scope="col">{t('panelRange')}</th>
                    <th scope="col">{t('panelHighYearChance')}</th>
                    <th scope="col">{t('panelEstimatedCost')}</th>
                    <th scope="col"><span className="sr">{t('explainOpenTitle')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.years.slice(0, inputs.horizonYears).map((item, yearIndex) => (
                    <tr key={item.year}>
                      <th scope="row">{item.year}</th>
                      <td>{formatCount(item.expected, locale)}</td>
                      <td>{formatCount(item.low, locale)}–{formatCount(item.high, locale)}</td>
                      <td>{formatShare(item.chanceAboveAlert, locale)}</td>
                      <td>{brl(item.costBrl)}</td>
                      <td className="explain-cell">
                        <ExplainButton
                          label={`${t('panelForecastYear')} ${item.year}`}
                          build={() => ({
                            context: explainForecastYear(region, inputs, context, yearIndex, explainOptions),
                            whatIf: forecastRunner({ region, inputs, context, yearIndex, options: explainOptions }),
                          })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sensor-note">
              {t('panelHighYearDef', { threshold: formatCount(forecast.alertThreshold, locale) })}
              {' '}{forecast.trendPctDecade === null
                ? t('panelNoTrend')
                : t('panelTrendApplied', { trend: forecast.trendPctDecade.toLocaleString(locale, { maximumFractionDigits: 1 }) })}
            </p>
          </article>

          <div className="calc-split">
            <article className="card">
              <header className="card-head"><h3>{t('panelPeakMonths')}</h3></header>
              <ul className="calc-months" aria-label={t('panelExpectedByMonth')}>
                {forecast.months.map((month) => (
                  <li key={month.label} className={month.peak ? 'peak' : undefined}>
                    <span className="calc-month-label">{month.label}</span>
                    <span className="calc-bar" aria-hidden="true">
                      <i style={{ width: `${(month.expected / maxMonthly) * 100}%` } as CSSProperties} />
                    </span>
                    <span className="calc-month-value">{formatCount(month.expected, locale)}</span>
                  </li>
                ))}
              </ul>
              <p className="sensor-note">
                {t('panelPeakLine', { months: forecast.peakMonths.join(', ') || t('panelNoClearPattern') })}
              </p>
            </article>

            <article className="card">
              <header className="card-head"><h3>{t('panelPostsResponse')}</h3>{statExplain(t('panelPostsResponse'))}</header>
              <dl className="method-list">
                <div><dt>{t('panelRegionArea')}</dt><dd>{formatArea(forecast.posts.areaKm2, locale)}</dd></div>
                <div><dt>{t('panelPostsByCoverage')}</dt><dd>{forecast.posts.coverageMinPosts}</dd></div>
                <div><dt>{t('panelPostsByPeak')}</dt><dd>{forecast.posts.workloadPosts}</dd></div>
                <div><dt>{t('panelPostsRecommended')}</dt><dd>{forecast.posts.recommendedPosts}</dd></div>
                <div><dt>{t('panelPostsMissing')}</dt><dd>{forecast.posts.missingPosts}</dd></div>
                <div><dt>{t('panelResponseCurrent')}</dt><dd>{minutes(forecast.posts.currentMinutes)}</dd></div>
                <div><dt>{t('panelResponseRecommended')}</dt><dd>{minutes(forecast.posts.recommendedMinutes)}</dd></div>
              </dl>
              <p className="sensor-note">{t('panelResponseNote')}</p>
            </article>
          </div>

          <article className="card">
            <header className="card-head">
              <div><h3>{t('panelHorizonTotals')}</h3><p>{t('panelPlanCost', { years: years(inputs.horizonYears) })}</p></div>
            </header>
            <div className="kpis calc-kpis">
              <Stat label={t('panelTotalCost')} value={brl(forecast.totals.costBrl)} />
              <Stat label={t('panelAvoidedFocuses')} value={formatCount(forecast.totals.avoidedFocuses, locale)} />
              <Stat label={t('panelCostPerAvoided')} value={forecast.totals.costPerAvoided === null ? '—' : brl(forecast.totals.costPerAvoided)} />
            </div>
            <p className="sensor-note">
              {t('panelCostFormula')}
              {' '}{t('panelUncertaintyLine', { value: forecast.uncertaintyPct === null ? t('panelNotInformed') : `±${Math.round(forecast.uncertaintyPct)}%` })}
              {' '}{t('panelConfidenceLine', { level: forecast.confidence ? levelLabel(forecast.confidence, t) : t('panelNotInformed') })}
            </p>
          </article>
          {rankingCard}
        </div>
        )}
      </div>
    </section>
  )
}

/** "1 ano" / "3 anos" no idioma atual. */
function yearsText(count: number, t: Translate): string {
  return t(count === 1 ? 'panelYearOne' : 'panelYearMany', { years: count })
}

function Stat({ label, value, explain }: { label: string; value: string; explain?: ReactNode }) {
  return (
    <article className="kpi" style={{ '--accent': 'var(--teal)' } as CSSProperties}>
      <div className="kpi-label"><span>{label}</span>{explain}</div>
      <div className="kpi-value calc-stat">{value}</div>
    </article>
  )
}

type SelectedPlaceProps = {
  ref: Ref<HTMLElement>
  cell: FireCell
  grid: FireGrid | null
  regions: RegionSeries[]
  text: PanelText
  onClear?: () => void
}

/** Bloco "Local selecionado": a hipótese da célula clicada no mapa, sempre com faixa e ressalvas. */
function SelectedPlace({ ref, cell, grid, regions, text, onClear }: SelectedPlaceProps) {
  const { t, locale } = text
  const regionName = regions.find((item) => item.id === cell.regionId)?.name ?? cell.regionId
  const summary = grid?.regions.find((item) => item.regionId === cell.regionId) ?? null
  const days = grid?.horizonDays ?? 0
  const daysLabel = days === 1 ? t('fireMapDays1') : t('fireMapDaysN', { n: days.toLocaleString(locale) })
  const chance = formatChance(cell.p, locale)
  const caveats = (grid?.caveats ?? []).flatMap((key) => (CAVEAT_KEYS[key] ? [CAVEAT_KEYS[key]] : []))
  const factor = summary === null
    ? '—'
    : summary.seasonal
      ? `×${summary.seasonalFactor.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : t('calcLocalSeasonalNone')

  return (
    <article ref={ref} className="card calc-local" aria-label={t('calcLocalAria')} aria-live="polite">
      <header className="card-head">
        <div>
          <h3>{t('calcLocalTitle')}</h3>
          <p className="calc-local-coords mono">{formatLatLon(cell.center[0], cell.center[1], locale)}</p>
        </div>
        <div className="card-head-actions">
          {grid && (
            <span className={`tag calc-local-confidence ${grid.confidence}`}>
              {t('fireMapConfidence', { level: levelLabel(grid.confidence, t) })}
            </span>
          )}
          {onClear && <button className="btn ghost" type="button" onClick={onClear}>{t('calcLocalClear')}</button>}
        </div>
      </header>
      <div className="calc-local-body">
        <div className="calc-local-chance">
          <strong>{chance}</strong>
          <span>{t('calcLocalChance', { days: daysLabel })}</span>
          <small>{t('calcLocalRange')}: {formatChance(cell.pLow, locale)}–{formatChance(cell.pHigh, locale)}</small>
        </div>
        <dl className="method-list calc-local-list">
          <div><dt>{t('calcLocalRegion')}</dt><dd>{regionName}</dd></div>
          <div><dt>{t('calcLocalCenter')}</dt><dd>{formatLatLon(cell.center[0], cell.center[1], locale)}</dd></div>
          <div><dt>{t('calcLocalExpected')}</dt><dd>{smallNumber(cell.expected, locale)}</dd></div>
          <div><dt>{t('calcLocalObserved')}</dt><dd>{formatCount(cell.observed, locale)}</dd></div>
          <div><dt>{t('calcLocalDailyRate')}</dt><dd>{summary ? t('calcLocalDailyRateValue', { value: smallNumber(summary.dailyRate, locale) }) : '—'}</dd></div>
          <div><dt>{t('calcLocalSeasonal')}</dt><dd>{factor}</dd></div>
        </dl>
      </div>
      <p className="calc-local-hypothesis">{t('calcLocalHypothesis', { p: chance, days: daysLabel })}</p>
      <p className="calc-local-range-note">{t('calcLocalRangeNote')}</p>
      {caveats.length > 0 && (
        <ul className="calc-local-caveats">
          {caveats.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
      )}
    </article>
  )
}

/** Altura da barra de navegação quando ela está fixa no rodapé (celular); 0 no desktop. */
function fixedBottomBarHeight(): number {
  const bar = document.querySelector('.sidebar')
  if (!(bar instanceof HTMLElement) || getComputedStyle(bar).position !== 'fixed') return 0
  const viewport = window.innerHeight || document.documentElement.clientHeight
  return Math.max(0, viewport - bar.getBoundingClientRect().top)
}

/** Valores pequenos (λ e taxas costumam ficar abaixo de 1) com dois algarismos significativos. */
function smallNumber(value: number, locale: PanelText['locale']): string {
  if (value > 0 && value < 1) return value.toLocaleString(locale, { maximumSignificantDigits: 2 })
  return formatCount(value, locale)
}
