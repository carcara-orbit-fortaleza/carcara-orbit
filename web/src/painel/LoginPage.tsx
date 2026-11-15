import { useState, type FormEvent } from 'react'
import { login, LoginError, type SessionUser } from './auth'

interface LoginPageProps {
  onLogin: (user: SessionUser) => void
  notice?: string
}

export function LoginPage({ onLogin, notice }: LoginPageProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(notice ?? null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await login(email, password))
    } catch (err) {
      setError(err instanceof LoginError ? err.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="painel-login">
      <form className="painel-login-card" onSubmit={submit} noValidate>
        <h1>Entrar no painel</h1>
        <p className="painel-login-lead">Acesso restrito à equipe do Carcará Orbit.</p>

        <label htmlFor="login-email">E-mail</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="login-password">Senha</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error ? (
          <p role="alert" className="painel-login-error">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy || !email || !password}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  )
}
