import { useEffect, useState } from 'react'
import './painel.css'
import App from './App'
import { fetchSession, logout, type SessionUser } from './auth'
import { LoginPage } from './LoginPage'

type Gate = { status: 'checking' } | { status: 'anon'; notice?: string } | { status: 'ready'; user: SessionUser }

// Rota /painel. O CSS do painel só é carregado aqui, porque o componente é importado de forma preguiçosa.
export default function PainelRoute() {
  const [gate, setGate] = useState<Gate>({ status: 'checking' })

  useEffect(() => {
    let active = true
    fetchSession()
      .then((user) => {
        if (!active) return
        setGate(user ? { status: 'ready', user } : { status: 'anon' })
      })
      .catch(() => {
        if (active) setGate({ status: 'anon', notice: 'Não foi possível falar com a API. Tente de novo em instantes.' })
      })
    return () => {
      active = false
    }
  }, [])

  if (gate.status === 'checking') {
    return <p className="painel-status">Verificando sessão…</p>
  }

  if (gate.status === 'anon') {
    return <LoginPage notice={gate.notice} onLogin={(user) => setGate({ status: 'ready', user })} />
  }

  async function handleLogout() {
    await logout()
    setGate({ status: 'anon' })
  }

  return (
    <>
      <header className="painel-topbar">
        <img src="/logo.png" alt="Carcará Orbit" width="32" height="24" className="painel-topbar-logo" />
        <span className="painel-topbar-name">{gate.user.name}</span>
        <button type="button" onClick={handleLogout}>
          Sair
        </button>
      </header>
      <App />
    </>
  )
}
