import type { Locale } from '../../i18n/messages'
import type { Workspace } from '../types'

// Nomes de região e bioma, pelo id estável. A API pode devolver nomes em outro idioma ou com
// codificação quebrada; o id é a única chave confiável. Trocar o idioma troca estes nomes.
const REGION_NAMES: Record<Locale, Record<string, string>> = {
  'pt-BR': {
    amazonia: 'Amazônia',
    cerrado: 'Cerrado',
    pantanal: 'Pantanal',
    caatinga: 'Caatinga',
    'mata-atlantica': 'Mata Atlântica',
    pampa: 'Pampa',
  },
  en: {
    amazonia: 'Amazon',
    cerrado: 'Cerrado',
    pantanal: 'Pantanal',
    caatinga: 'Caatinga',
    'mata-atlantica': 'Atlantic Forest',
    pampa: 'Pampa',
  },
}

const BIOME_NAMES: Record<Locale, Record<string, string>> = {
  'pt-BR': {
    amazonia: 'Floresta tropical',
    cerrado: 'Savana tropical',
    pantanal: 'Área úmida',
    caatinga: 'Floresta seca',
    'mata-atlantica': 'Floresta costeira',
    pampa: 'Campo subtropical',
  },
  en: {
    amazonia: 'Tropical forest',
    cerrado: 'Tropical savanna',
    pantanal: 'Wetland',
    caatinga: 'Dry forest',
    'mata-atlantica': 'Coastal forest',
    pampa: 'Subtropical grassland',
  },
}

/** Troca nomes de região e bioma para o idioma atual. Sem entrada para o id, mantém o nome da API. */
export function localizeWorkspace(workspace: Workspace, locale: Locale): Workspace {
  return {
    ...workspace,
    regions: workspace.regions.map((region) => ({
      ...region,
      name: REGION_NAMES[locale][region.id] ?? region.name,
      metrics: { ...region.metrics, biome: BIOME_NAMES[locale][region.id] ?? region.metrics.biome },
    })),
  }
}
