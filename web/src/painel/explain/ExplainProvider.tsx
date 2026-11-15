import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExplainPanel } from './ExplainPanel'
import { ExplainStateContext, type ExplainApi, type ExplainPayload } from './explainState'

type Open = { payload: ExplainPayload; serial: number }

/** Um único provider no painel: guarda o dado aberto e renderiza o único <dialog> lateral. */
export function ExplainProvider({ children, disabledReason = null }: { children: ReactNode; disabledReason?: string | null }) {
  const [current, setCurrent] = useState<Open | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const serial = useRef(0)

  const open = useCallback<ExplainApi['open']>((build, from) => {
    opener.current = from
    serial.current += 1
    const payload = build()
    if (!payload) return
    setCurrent({ payload, serial: serial.current })
  }, [])

  const close = useCallback(() => {
    setCurrent(null)
    const target = opener.current
    opener.current = null
    // O dialog nativo já devolve o foco; o explícito cobre navegadores que não o fazem.
    if (target?.isConnected) target.focus()
  }, [])

  const api = useMemo<ExplainApi>(() => ({ open, close, disabledReason }), [open, close, disabledReason])

  return (
    <ExplainStateContext.Provider value={api}>
      {children}
      <ExplainPanel open={current} onClose={close} />
    </ExplainStateContext.Provider>
  )
}
