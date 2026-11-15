import type { Locale } from '../../i18n/messages'

// Todos os formatadores recebem o idioma atual: separador decimal e de milhar mudam com ele.

export function formatCount(value: number, locale: Locale): string {
  if (value > 0 && value < 10) {
    return value.toLocaleString(locale, { maximumFractionDigits: 1 })
  }
  return Math.round(value).toLocaleString(locale)
}

export function formatSignedPercent(value: number, locale: Locale): string {
  const digits = Math.abs(value) >= 10 ? 0 : 1
  const body = value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${value > 0 ? '+' : ''}${body}%`
}

export function formatShare(weight: number, locale: Locale): string {
  const percent = weight * 100
  const digits = percent >= 10 ? 0 : 1
  return `${percent.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`
}

/** Teto e piso mostrados para uma chance estimada: o modelo nunca afirma certeza nem impossibilidade. */
export const CHANCE_DISPLAY_MAX = 0.99
export const CHANCE_DISPLAY_MIN = 0.01

/**
 * Chance estimada (hipótese) para a interface: nunca "100%" nem "0%". Acima do teto vira ">99%",
 * abaixo do piso vira "<1%"; no meio segue formatShare. O valor cru fica no modelo e no CSV.
 */
export function formatChance(p: number, locale: Locale): string {
  if (!(p < CHANCE_DISPLAY_MAX)) return `>${formatWhole(CHANCE_DISPLAY_MAX * 100, locale)}%`
  if (!(p >= CHANCE_DISPLAY_MIN)) return `<${formatWhole(CHANCE_DISPLAY_MIN * 100, locale)}%`
  // Abaixo do teto, formatShare arredonda para no máximo "99%"; acima do piso, no mínimo "1,0%".
  return formatShare(p, locale)
}

function formatWhole(value: number, locale: Locale): string {
  return Math.round(value).toLocaleString(locale)
}

export function formatArea(km2: number, locale: Locale): string {
  if (km2 >= 100) return `${Math.round(km2).toLocaleString(locale)} km²`
  return `${km2.toLocaleString(locale, { maximumFractionDigits: 1 })} km²`
}

// Letras de hemisfério por idioma: oeste é "O" em português e "W" em inglês.
const HEMISPHERES: Record<Locale, { n: string; s: string; e: string; w: string }> = {
  'pt-BR': { n: 'N', s: 'S', e: 'L', w: 'O' },
  en: { n: 'N', s: 'S', e: 'E', w: 'W' },
}

/** Coordenada legível, latitude primeiro: "7,38° S, 55,12° O" (pt-BR) ou "7.38° S, 55.12° W" (en). */
export function formatLatLon(lon: number, lat: number, locale: Locale, digits = 2): string {
  const h = HEMISPHERES[locale] ?? HEMISPHERES.en
  const part = (value: number) => Math.abs(value).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${part(lat)}° ${lat < 0 ? h.s : h.n}, ${part(lon)}° ${lon < 0 ? h.w : h.e}`
}
