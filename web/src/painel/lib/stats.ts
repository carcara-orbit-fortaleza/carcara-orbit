// Estatística básica compartilhada por forecast, dashboard e series. Uma única implementação:
// a explicação (explain/) e o cálculo usam exatamente estas funções, então não podem divergir.

/** Média aritmética. Lista vazia devolve 0: quem precisa distinguir "sem dado" deve checar o tamanho antes. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Percentil por interpolação linear (p em 0..1). Ordena uma cópia; lista vazia devolve 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}
