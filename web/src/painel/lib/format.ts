const MONTHS_LONG = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]

export function monthName(index: number): string {
  return MONTHS_LONG[index] ?? ''
}

export function formatCount(value: number): string {
  if (value > 0 && value < 10) {
    return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  }
  return Math.round(value).toLocaleString('pt-BR')
}

export function formatSignedPercent(value: number): string {
  const digits = Math.abs(value) >= 10 ? 0 : 1
  const body = value.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${value > 0 ? '+' : ''}${body}%`
}

export function formatShare(weight: number): string {
  const percent = weight * 100
  const digits = percent >= 10 ? 0 : 1
  return `${percent.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`
}

export function formatArea(km2: number): string {
  if (km2 >= 100) return `${Math.round(km2).toLocaleString('pt-BR')} km²`
  return `${km2.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km²`
}
