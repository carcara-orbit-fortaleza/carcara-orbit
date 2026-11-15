import type { ExplainContextInput } from './explain.schema.js';

// Fixture compartilhada pelos testes (não é importada em produção).
export function makeContext(overrides: Partial<ExplainContextInput> = {}): ExplainContextInput {
  return {
    schema: 1,
    kind: 'kpi-count',
    labelKey: 'panelKpiCount',
    scope: { mode: 'region', regionId: 'amazonia', regionName: 'Amazon' },
    value: { raw: 385, unit: 'hotspots' },
    source: {
      datasetMode: 'real',
      methodVersion: 'h1.0',
      datasetVersion: 'firms-1.0',
      sensors: ['MODIS', 'VIIRS'],
      period: '2026-11',
      baseline: null,
    },
    formula: {
      derivedBy: 'client',
      steps: [
        { id: 'sum', expr: 'MODIS + VIIRS x fator', values: { modis: 385, factor: 1 }, result: 385 },
      ],
    },
    uncertainty: {
      pct: 100,
      confidence: 'low',
      sampleSize: 1,
      interval: { low: null, high: null, label: 'none' },
    },
    history: { labelKey: 'h', points: [{ x: 2026, y: 385, partial: true }] },
    whatChanges: [],
    caveats: [{ id: 'not-operational' }],
    ...overrides,
  };
}
