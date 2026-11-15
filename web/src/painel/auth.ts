// Sessão do painel. A API guarda o cookie httpOnly; aqui só perguntamos quem está logado.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'analyst'
}

export class LoginError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Usuário logado, ou null quando não há sessão (401). Erro de rede é propagado. */
export async function fetchSession(): Promise<SessionUser | null> {
  const response = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
  if (response.status === 401) return null
  if (!response.ok) throw new LoginError(response.status, 'Não foi possível verificar a sessão.')
  const body = (await response.json()) as { user: SessionUser }
  return body.user
}

export async function login(email: string, password: string): Promise<SessionUser> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new LoginError(0, 'Sem conexão com a API.')
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new LoginError(response.status, body.message ?? 'Não foi possível entrar.')
  }
  const body = (await response.json()) as { user: SessionUser }
  return body.user
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
}
