import './painel.css'
import App from './App'

// Rota /painel. Aberta a todos, sem login. O CSS do painel só é carregado aqui, porque o componente é importado de forma preguiçosa.
export default function PainelRoute() {
  return <App />
}
