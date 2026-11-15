// Cliente dos focos globais da API. Sem API ou sem dados ingeridos, retorna
// null e o globo mantém a demonstração.

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

// Mundo inteiro: oeste, sul, leste, norte.
const WORLD_BBOX = '-180,-90,180,90'

interface HotspotsResponse {
  mode: 'mock' | 'real' | 'global'
  total: number
  features: {
    geometry: { coordinates: [number, number] }
    properties: { frp_mw: number | null; confidence_class: string }
  }[]
}

const CONFIDENCE: Record<string, FireConfidence> = {
  alta: 'high',
  high: 'high',
  nominal: 'nominal',
  baixa: 'low',
  low: 'low',
}

export async function fetchRecentFires(limit: number, signal?: AbortSignal): Promise<RecentFires | null> {
  try {
    const response = await fetch(`${API_BASE}/global/hotspots?bbox=${WORLD_BBOX}&limit=${limit}`, { signal })
    if (!response.ok) return null
    const json = (await response.json()) as HotspotsResponse
    // Só aceita dados globais reais. Sem focos, o globo mantém a demonstração.
    if (json.mode !== 'global' || !Array.isArray(json.features) || json.features.length === 0) return null
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
