// Contrato do "?" (explicação de cada dado). É a ÚNICA fonte de verdade do formato:
// o painel renderiza este objeto e a API (POST /api/explain) recebe o mesmo objeto
// como contexto para o modelo. Mantenha em sincronia com api/src/explain/explain.schema.ts.
//
// Regras de honestidade científica embutidas no formato:
//  - Números crus (nunca formatados): o texto é montado na renderização, com i18n.
//  - null significa "sem dado" e nunca vira 0.
//  - Todo resultado carrega incerteza, amostra (n) e ressalvas explícitas.

export type ExplainKind =
  | 'kpi-count'
  | 'kpi-anomaly'
  | 'kpi-peak'
  | 'kpi-trend'
  | 'confidence'
  | 'sensor-mix'
  | 'method-factor'
  | 'climatology'
  | 'annual'
  | 'calendar-cell'
  | 'forecast-year'
  | 'forecast-ranking'
  | 'post-plan'
  | 'hotspot'

export type ExplainScalar = number | string | boolean | null

/** Ressalvas conhecidas. O id é traduzido no front; a API só repassa o id e os parâmetros. */
export type CaveatId =
  | 'not-operational' // calibração ainda sem sobreposição MODIS/VIIRS: não usar para decisão operacional
  | 'mock-data' // dados de demonstração
  | 'insufficient-reference' // menos de MIN_REFERENCE_YEARS anos de referência
  | 'exceedance-not-calibrated' // chanceAboveAlert é taxa empírica dentro da amostra (~25% por construção), não probabilidade calibrada
  | 'range-is-minmax' // com n pequeno, P05–P95 equivale a mínimo–máximo
  | 'polygon-approximation' // polígono: pesos por sobreposição, incerteza média ponderada, confiança fixa "estimated"
  | 'trend-anchor' // tendência ancorada em baseline.to e janela da API pode diferir da janela do cenário
  | 'hotspot-proxy' // focos de calor são proxy de atividade, não área queimada nem causa
  | 'sensor-mix' // mistura MODIS/VIIRS muda detecção ao longo do tempo
  | 'placeholder-costs' // custos/produtividade são premissas ilustrativas

export type ExplainCaveat = { id: CaveatId; params?: Record<string, ExplainScalar> }

export type ExplainStep = {
  /** Identificador estável do passo (ex.: 'mean', 'threshold', 'factor'); traduzido como explain.step.<id>. */
  id: string
  /** Expressão simbólica legível, ex.: "média(amostra) × fator". Não traduzida (matemática). */
  expr: string
  /** Valores reais substituídos, crus. */
  values: Record<string, ExplainScalar>
  result: ExplainScalar
  unit?: string
}

export type ExplainHistoryPoint = { x: number | string; y: number | null; partial?: boolean }

export type ExplainWhatChanges = {
  /** Id traduzido como explain.change.<id>. */
  id: string
  params?: Record<string, ExplainScalar>
}

/** Parâmetros que o usuário pode variar na camada "E se?" (nível 2). Todos opcionais. */
export type WhatIfParams = {
  baselineFrom?: number
  baselineTo?: number
  trendPctDecade?: number | null
  alertPercentile?: number // 0..1
  horizonYear?: number
}

export type ExplainWhatIfSpec = {
  /** Quais controles esta explicação aceita. */
  controls: Array<'baseline' | 'trend' | 'alertPercentile' | 'horizonYear'>
  /** Valores atuais, para pré-preencher os controles. */
  current: Required<Pick<WhatIfParams, 'baselineFrom' | 'baselineTo' | 'alertPercentile'>> &
    Pick<WhatIfParams, 'trendPctDecade' | 'horizonYear'>
}

export type ExplainContext = {
  /** Versão do formato, incrementar em mudança incompatível. */
  schema: 1
  kind: ExplainKind
  /** Chave i18n do rótulo curto do dado (ex.: 'panelKpiCount'); o front resolve. */
  labelKey: string
  scope: {
    mode: 'region' | 'polygon'
    regionId: string | null
    regionName: string
    /** Só em polygon: regiões e pesos de sobreposição usados. */
    weights?: Array<{ regionId: string; weight: number }>
  }
  value: { raw: number | null; unit: string }
  source: {
    datasetMode: 'real' | 'mock' | 'unknown'
    methodVersion: string | null
    datasetVersion: string | null
    sensors: string[]
    period: string | null
    baseline: { from: number; to: number } | null
  }
  /** Passos do cálculo com valores reais. Vazio quando o valor vem pronto da API (então derivedBy='api'). */
  formula: { derivedBy: 'client' | 'api'; steps: ExplainStep[] }
  uncertainty: {
    pct: number | null
    confidence: string | null
    /** n: anos (ou observações) na amostra usada. */
    sampleSize: number | null
    interval: { low: number | null; high: number | null; label: 'p05-p95' | 'min-max' | 'none' }
  }
  history: { labelKey: string; points: ExplainHistoryPoint[]; highlightX?: number | string }
  whatChanges: ExplainWhatChanges[]
  caveats: ExplainCaveat[]
  whatIf?: ExplainWhatIfSpec
}

/** Pedido do nível 3. A pergunta é texto livre e NÃO confiável. */
export type ExplainAskRequest = {
  context: ExplainContext
  question: string
  locale: 'pt-BR' | 'en'
}

export type ExplainAskResponse = {
  /** Texto simples, sem HTML/Markdown executável. */
  answer: string
  /** Caminhos do contexto que sustentam a resposta, ex.: 'formula.steps[1].values.threshold'. */
  citations: string[]
  /** Autoavaliação do modelo, nunca substitui uncertainty do contexto. */
  confidence: 'low' | 'medium' | 'high'
  /** true quando o contexto não permite responder. */
  insufficient: boolean
  /** Metadados para auditoria. */
  meta: { model: string; methodVersion: string | null; datasetMode: string }
}

export type ExplainAskError = {
  statusCode: number
  /** 'explain_disabled' | 'rate_limited' | 'budget_exhausted' | 'invalid_request' | 'upstream_error' */
  code: string
  message: string
}
