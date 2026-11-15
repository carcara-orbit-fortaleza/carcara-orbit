import { useMemo, useState, type CSSProperties, type ChangeEvent } from 'react'
import { DEFAULT_INPUTS, forecastRegion, overviewRegions, type CalcInputs } from '../lib/forecast'
import { formatArea, formatCount, formatShare } from '../lib/format'
import type { RegionSeries } from '../types'

type Props = {
  regions: RegionSeries[]
  years: number[]
  initialRegionId: string
}

const HORIZONS = [1, 3, 5, 10]

export function RiskCalculator({ regions, years, initialRegionId }: Props) {
  const [regionId, setRegionId] = useState(initialRegionId)
  const [inputs, setInputs] = useState<CalcInputs>(DEFAULT_INPUTS)

  const region = regions.find((item) => item.id === regionId) ?? regions[0]
  const forecast = useMemo(
    () => (region ? forecastRegion(region, years, inputs) : null),
    [region, years, inputs],
  )
  const overview = useMemo(() => overviewRegions(regions, years, inputs), [regions, years, inputs])

  function setNumber(key: keyof CalcInputs) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value)
      setInputs((current) => ({ ...current, [key]: Number.isFinite(value) ? value : 0 }))
    }
  }

  if (!region || !forecast) return null

  const brl = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
  const minutes = (value: number | null) => (value === null ? '—' : `${Math.round(value)} min`)
  const maxMonthly = Math.max(1, ...forecast.months.map((month) => month.expected))

  return (
    <section className="calc-section" id="calculadora" aria-labelledby="calc-title">
      <header className="calc-head">
        <div>
          <p className="eyebrow">CALCULADORA DE CENÁRIOS</p>
          <h2 id="calc-title">Quando, onde e quanto custa prevenir</h2>
          <p className="sub">
            Projeção a partir da série histórica do painel. Cada número é uma hipótese com probabilidade, não uma certeza.
            Premissas de custo e de postos são exemplos: troque pelos valores reais.
          </p>
        </div>
        <span className="tag mono">h1.0</span>
      </header>

      <div className="calc-grid">
        <form className="card calc-form" onSubmit={(event) => event.preventDefault()} aria-label="Premissas da calculadora">
          <header className="card-head"><h3>Premissas</h3></header>

          <fieldset className="calc-field">
            <legend>Onde</legend>
            <label>
              Área de interesse
              <select value={region.id} onChange={(event) => setRegionId(event.target.value)}>
                {regions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </fieldset>

          <fieldset className="calc-field">
            <legend>Quando</legend>
            <div className="segmented small" role="group" aria-label="Horizonte">
              {HORIZONS.map((horizon) => (
                <button
                  key={horizon}
                  type="button"
                  className={inputs.horizonYears === horizon ? 'active' : undefined}
                  aria-pressed={inputs.horizonYears === horizon}
                  onClick={() => setInputs((current) => ({ ...current, horizonYears: horizon }))}
                >
                  {horizon} {horizon === 1 ? 'ano' : 'anos'}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="calc-field">
            <legend>Postos de combate</legend>
            <label>
              Postos existentes
              <input type="number" min={0} step={1} value={inputs.existingPosts} onChange={setNumber('existingPosts')} />
            </label>
            <label>
              Raio de cobertura por posto (km)
              <input type="number" min={1} step={5} value={inputs.coverageRadiusKm} onChange={setNumber('coverageRadiusKm')} />
            </label>
            <label>
              Velocidade média de deslocamento (km/h)
              <input type="number" min={1} step={5} value={inputs.travelSpeedKmh} onChange={setNumber('travelSpeedKmh')} />
            </label>
            <label>
              Focos que um posto atende por mês
              <input type="number" min={1} step={5} value={inputs.focusesPerPostMonth} onChange={setNumber('focusesPerPostMonth')} />
            </label>
          </fieldset>

          <fieldset className="calc-field">
            <legend>Custo</legend>
            <label>
              Custo anual por posto (R$)
              <input type="number" min={0} step={10000} value={inputs.postCostPerYear} onChange={setNumber('postCostPerYear')} />
            </label>
            <label>
              Custo por foco evitado (R$)
              <input type="number" min={0} step={100} value={inputs.costPerAvoidedFocus} onChange={setNumber('costPerAvoidedFocus')} />
            </label>
            <label>
              Redução-alvo dos focos (%)
              <input type="number" min={0} max={100} step={5} value={inputs.targetReductionPct} onChange={setNumber('targetReductionPct')} />
            </label>
          </fieldset>
        </form>

        <div className="calc-results">
          <article className="card">
            <header className="card-head">
              <div><h3>Projeção por ano · {region.name}</h3><p>Esperado e faixa p05–p95 a partir dos anos de referência</p></div>
              <span className="tag">{forecast.sampleYears} anos de referência</span>
            </header>
            <div className="table-scroll">
              <table className="calc-table">
                <caption className="sr">Projeção anual de focos, chance de ano alto e custo estimado</caption>
                <thead>
                  <tr>
                    <th scope="col">Ano</th>
                    <th scope="col">Focos esperados</th>
                    <th scope="col">Faixa (p05–p95)</th>
                    <th scope="col">Chance de ano alto</th>
                    <th scope="col">Custo estimado</th>
                  </tr>
                </thead>
                <tbody>
                  {forecast.years.slice(0, inputs.horizonYears).map((item) => (
                    <tr key={item.year}>
                      <th scope="row">{item.year}</th>
                      <td>{formatCount(item.expected)}</td>
                      <td>{formatCount(item.low)}–{formatCount(item.high)}</td>
                      <td>{formatShare(item.chanceAboveAlert)}</td>
                      <td>{brl(item.costBrl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sensor-note">
              Ano alto = acima de {formatCount(forecast.alertThreshold)} focos, limiar do percentil 75 da série de referência.
              Tendência de {forecast.trendPctDecade.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%/década aplicada ano a ano.
            </p>
          </article>

          <div className="calc-split">
            <article className="card">
              <header className="card-head"><h3>Meses de maior risco</h3></header>
              <ul className="calc-months" aria-label="Focos esperados por mês">
                {forecast.months.map((month) => (
                  <li key={month.label} className={month.peak ? 'peak' : undefined}>
                    <span className="calc-month-label">{month.label}</span>
                    <span className="calc-bar" aria-hidden="true">
                      <i style={{ width: `${(month.expected / maxMonthly) * 100}%` } as CSSProperties} />
                    </span>
                    <span className="calc-month-value">{formatCount(month.expected)}</span>
                  </li>
                ))}
              </ul>
              <p className="sensor-note">
                Pico: {forecast.peakMonths.join(', ') || 'sem padrão claro'}.
              </p>
            </article>

            <article className="card">
              <header className="card-head"><h3>Postos e resposta</h3></header>
              <dl className="method-list">
                <div><dt>Área da região</dt><dd>{formatArea(forecast.posts.areaKm2)}</dd></div>
                <div><dt>Postos por cobertura</dt><dd>{forecast.posts.coverageMinPosts}</dd></div>
                <div><dt>Postos por carga no pico</dt><dd>{forecast.posts.workloadPosts}</dd></div>
                <div><dt>Postos recomendados</dt><dd>{forecast.posts.recommendedPosts}</dd></div>
                <div><dt>Faltam</dt><dd>{forecast.posts.missingPosts}</dd></div>
                <div><dt>Resposta com postos atuais</dt><dd>{minutes(forecast.posts.currentMinutes)}</dd></div>
                <div><dt>Resposta com recomendação</dt><dd>{minutes(forecast.posts.recommendedMinutes)}</dd></div>
              </dl>
              <p className="sensor-note">
                Tempo médio até o posto mais próximo, aproximado. Não considera relevo, estrada ruim ou horário.
              </p>
            </article>
          </div>

          <article className="card">
            <header className="card-head">
              <div><h3>Totais do horizonte</h3><p>Custo do plano de {inputs.horizonYears} {inputs.horizonYears === 1 ? 'ano' : 'anos'}</p></div>
            </header>
            <div className="kpis calc-kpis">
              <Stat label="Custo total" value={brl(forecast.totals.costBrl)} />
              <Stat label="Focos evitados" value={formatCount(forecast.totals.avoidedFocuses)} />
              <Stat label="Custo por foco evitado" value={forecast.totals.costPerAvoided === null ? '—' : brl(forecast.totals.costPerAvoided)} />
            </div>
            <p className="sensor-note">
              Custo = postos recomendados × custo anual por posto + focos evitados × custo por foco evitado.
              Incerteza estimada da harmonização: ±{Math.round(forecast.uncertaintyPct)}%. Confiança: {forecast.confidence || 'não informada'}.
            </p>
          </article>

          <article className="card">
            <header className="card-head"><div><h3>Onde o risco é maior no próximo ano</h3><p>Ordenado pela chance de ano alto</p></div></header>
            <ol className="calc-rank">
              {overview.map((item) => (
                <li key={item.id}>
                  <i style={{ background: item.color }} aria-hidden="true" />
                  <span>{item.name}</span>
                  <small>{formatArea(item.areaKm2)}</small>
                  <strong>{formatShare(item.chanceAboveAlert)}</strong>
                  <small>{formatCount(item.expectedNext)} focos</small>
                </li>
              ))}
            </ol>
          </article>
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="kpi" style={{ '--accent': 'var(--teal)' } as CSSProperties}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value calc-stat">{value}</div>
    </article>
  )
}
