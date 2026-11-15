import { Component, type ReactNode } from 'react'

interface GlobeBoundaryProps {
  fallback: ReactNode
  children: ReactNode
}

interface GlobeBoundaryState {
  failed: boolean
}

// Isola o globo: se ele falhar (WebGL, carregamento do chunk ou render), a página continua
// e a arte estática entra no lugar, em vez de a árvore inteira sumir.
export class GlobeBoundary extends Component<GlobeBoundaryProps, GlobeBoundaryState> {
  state: GlobeBoundaryState = { failed: false }

  static getDerivedStateFromError(): GlobeBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Globo indisponível, usando arte estática.', error)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
