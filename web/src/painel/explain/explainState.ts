// Tipos e contexto React do "?". Fica fora do .tsx para o provider exportar só componente.
import { createContext, useContext } from 'react'
import type { Vars } from '../../i18n/I18nContext'
import type { ExplainContext, WhatIfParams } from './types'

/** Linha "era X, agora Y" da camada "E se?". `id` vira explain.whatif.row.<id>. */
export type WhatIfRow = {
  id: string
  before: number | null
  after: number | null
  delta: number | null
  format: 'count' | 'percent' | 'share' | 'factor' | 'year' | 'years'
}

export type WhatIfIssueView = { code: string; param: string; requested: number | null; used: number | null }

export type WhatIfOutcome =
  | { ok: false; issues: WhatIfIssueView[] }
  | { ok: true; rows: WhatIfRow[]; insufficient: { sampleYears: number; required: number } | null; issues: WhatIfIssueView[] }

/** Recalcula o dado sob novos parâmetros (usa explain/whatif.ts). Puro e sem exceção. */
export type WhatIfRunner = (params: WhatIfParams) => WhatIfOutcome

export type ExplainPayload = {
  context: ExplainContext
  /** Variáveis do rótulo (ex.: { year } em "Focos em {year}"). */
  labelVars?: Vars
  whatIf?: WhatIfRunner
}

export type ExplainApi = {
  /** `build` roda só ao clicar. `opener` recebe o foco de volta ao fechar. */
  open: (build: () => ExplainPayload | null, opener: HTMLElement | null) => void
  close: () => void
  /** Quando preenchido, os "?" ficam desativados e mostram esta razão (ex.: polígono sem sobreposição). */
  disabledReason: string | null
}

export const ExplainStateContext = createContext<ExplainApi | null>(null)

export function useExplain(): ExplainApi {
  const api = useContext(ExplainStateContext)
  if (!api) throw new Error('useExplain precisa estar dentro de ExplainProvider')
  return api
}
