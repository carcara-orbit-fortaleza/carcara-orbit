// Cliente dos focos reais da API. Sem API ou sem dados ingeridos, retorna null
// e o globo mantém a demonstração.

export type FireConfidence = 'low' | 'nominal' | 'high' | 'unknown'

export interface FirePoint {
  lat: number
  lon: number
  frp: number | null
  confidence: FireConfidence
}

export interface RecentFires {
  points: FirePoint[]
  total: number
}

// Em desenvolvimento a API roda na porta 3000. Em produção, defina VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api'

// Brasil: oeste, sul, leste, norte.
const BRAZIL_BBOX = '-74,-34,-34,6'

// Contrato atual da API (PR #1): `mode` indica a fonte e os focos trazem `frp_mw` e `confidence_class`.
interface HotspotsResponse {
  mode: 'mock' | 'real'
  total: number
  features: {
    geometry: { coordinates: [number, number] }
    properties: { frp_mw: number | null; confidence_class: 'alta' | 'nominal' | 'baixa' }
  }[]
}

const CONFIDENCE: Record<'alta' | 'nominal' | 'baixa', FireConfidence> = {
  alta: 'high',
  nominal: 'nominal',
  baixa: 'low',
}

export async function fetchRecentFires(limit: number, signal?: AbortSignal): Promise<RecentFires | null> {
  try {
    const response = await fetch(`${API_BASE}/hotspots?bbox=${BRAZIL_BBOX}&limit=${limit}`, { signal })
    if (!response.ok) return null
    const json = (await response.json()) as HotspotsResponse
    // Só aceita dados reais. Os de demonstração ficam por conta do próprio globo.
    if (json.mode !== 'real' || !Array.isArray(json.features)) return null
    return {
      total: json.total,
      points: json.features.map((feature) => ({
        lon: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
        frp: feature.properties.frp_mw ?? null,
        confidence: CONFIDENCE[feature.properties.confidence_class] ?? 'unknown',
      })),
    }
  } catch {
    // Sem API, rede ou cancelamento: o chamador decide o que mostrar.
    return null
  }
}
