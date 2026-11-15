import { z } from 'zod';

// Espelho em runtime de web/src/painel/explain/types.ts (ExplainAskRequest).
// Mantenha em sincronia com aquele arquivo. Chaves desconhecidas são rejeitadas.

// Contextos reais dos builders da web medem ~1,2-1,9 KB (fixtures, 9 anos); no pior caso
// plausível (~40 anos de histórico, polígono com dezenas de pesos, textos longos) ficam
// em ~8 KB. Teto = pior caso + ~50% de folga. O schema acima ainda aceita mais, por isso o teto é aplicado.
export const MAX_CONTEXT_BYTES = 12 * 1024;
export const MAX_QUESTION_CHARS = 400;

const str = (max: number) => z.string().max(max);
const scalar = z.union([z.number().finite(), str(300), z.boolean(), z.null()]);
const scalarRecord = z
  .record(str(64), scalar)
  .refine((r) => Object.keys(r).length <= 40, { message: 'too many keys' });

const EXPLAIN_KINDS = [
  'kpi-count',
  'kpi-anomaly',
  'kpi-peak',
  'kpi-trend',
  'confidence',
  'sensor-mix',
  'method-factor',
  'climatology',
  'annual',
  'calendar-cell',
  'forecast-year',
  'forecast-ranking',
  'post-plan',
  'hotspot',
] as const;

const CAVEAT_IDS = [
  'not-operational',
  'mock-data',
  'insufficient-reference',
  'exceedance-not-calibrated',
  'range-is-minmax',
  'polygon-approximation',
  'trend-anchor',
  'hotspot-proxy',
  'sensor-mix',
  'placeholder-costs',
] as const;

const xValue = z.union([z.number().finite(), str(64)]);

const stepSchema = z.strictObject({
  id: str(64),
  expr: str(300),
  values: scalarRecord,
  result: scalar,
  unit: str(32).optional(),
});

const historyPoint = z.strictObject({
  x: xValue,
  y: z.number().finite().nullable(),
  partial: z.boolean().optional(),
});

const whatIfParams = z.strictObject({
  baselineFrom: z.number().finite(),
  baselineTo: z.number().finite(),
  alertPercentile: z.number().finite(),
  trendPctDecade: z.number().finite().nullable().optional(),
  horizonYear: z.number().finite().optional(),
});

export const explainContextSchema = z
  .strictObject({
    schema: z.literal(1),
    kind: z.enum(EXPLAIN_KINDS),
    labelKey: str(100),
    scope: z.strictObject({
      mode: z.enum(['region', 'polygon']),
      regionId: str(64).nullable(),
      regionName: str(200),
      weights: z
        .array(z.strictObject({ regionId: str(64), weight: z.number().finite() }))
        .max(50)
        .optional(),
    }),
    value: z.strictObject({ raw: z.number().finite().nullable(), unit: str(32) }),
    source: z.strictObject({
      datasetMode: z.enum(['real', 'mock', 'unknown']),
      methodVersion: str(64).nullable(),
      datasetVersion: str(64).nullable(),
      sensors: z.array(str(64)).max(10),
      period: str(64).nullable(),
      baseline: z.strictObject({ from: z.number().finite(), to: z.number().finite() }).nullable(),
    }),
    formula: z.strictObject({
      derivedBy: z.enum(['client', 'api']),
      steps: z.array(stepSchema).max(40),
    }),
    uncertainty: z.strictObject({
      pct: z.number().finite().nullable(),
      confidence: str(32).nullable(),
      sampleSize: z.number().finite().nullable(),
      interval: z.strictObject({
        low: z.number().finite().nullable(),
        high: z.number().finite().nullable(),
        label: z.enum(['p05-p95', 'min-max', 'none']),
      }),
    }),
    history: z.strictObject({
      labelKey: str(100),
      points: z.array(historyPoint).max(400),
      highlightX: xValue.optional(),
    }),
    whatChanges: z
      .array(z.strictObject({ id: str(64), params: scalarRecord.optional() }))
      .max(20),
    caveats: z
      .array(z.strictObject({ id: z.enum(CAVEAT_IDS), params: scalarRecord.optional() }))
      .max(20),
    whatIf: z
      .strictObject({
        controls: z.array(z.enum(['baseline', 'trend', 'alertPercentile', 'horizonYear'])).max(4),
        current: whatIfParams,
      })
      .optional(),
  })
  .refine((ctx) => Buffer.byteLength(JSON.stringify(ctx), 'utf8') <= MAX_CONTEXT_BYTES, {
    message: `context exceeds ${MAX_CONTEXT_BYTES} bytes`,
  });

export const explainRequestSchema = z.strictObject({
  context: explainContextSchema,
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  locale: z.enum(['pt-BR', 'en']),
});

export type ExplainContextInput = z.infer<typeof explainContextSchema>;
export type ExplainRequestInput = z.infer<typeof explainRequestSchema>;

export type ExplainAskResponse = {
  answer: string;
  citations: string[];
  confidence: 'low' | 'medium' | 'high';
  insufficient: boolean;
  meta: { model: string; methodVersion: string | null; datasetMode: string };
};

export type ExplainErrorCode =
  | 'explain_disabled'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'invalid_request'
  | 'upstream_error';
