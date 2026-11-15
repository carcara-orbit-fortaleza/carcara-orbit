import { explainRequestSchema, MAX_CONTEXT_BYTES } from './explain.schema.js';
import { makeContext } from './fixtures.js';

const ok = () => ({ context: makeContext(), question: 'Why?', locale: 'en' as const });

describe('explainRequestSchema', () => {
  it('accepts a valid request', () => {
    expect(explainRequestSchema.safeParse(ok()).success).toBe(true);
  });
  it('rejects unknown keys at any level', () => {
    expect(explainRequestSchema.safeParse({ ...ok(), extra: 1 }).success).toBe(false);
    const c = { ...makeContext(), role: 'system' };
    expect(explainRequestSchema.safeParse({ ...ok(), context: c }).success).toBe(false);
  });
  it('bounds the question and the locale', () => {
    expect(explainRequestSchema.safeParse({ ...ok(), question: '' }).success).toBe(false);
    expect(explainRequestSchema.safeParse({ ...ok(), question: 'x'.repeat(401) }).success).toBe(false);
    expect(explainRequestSchema.safeParse({ ...ok(), locale: 'fr' }).success).toBe(false);
  });
  it('rejects an oversized context', () => {
    const ctx = makeContext();
    ctx.history.points = Array.from({ length: 400 }, (_, i) => ({ x: i, y: i }));
    ctx.formula.steps = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      expr: 'x'.repeat(300),
      values: { a: 'y'.repeat(300) },
      result: null,
    }));
    expect(Buffer.byteLength(JSON.stringify(ctx))).toBeGreaterThan(MAX_CONTEXT_BYTES);
    expect(explainRequestSchema.safeParse({ ...ok(), context: ctx }).success).toBe(false);
  });
  it('bounds arrays and never coerces null to 0', () => {
    const ctx = makeContext();
    ctx.history.points = Array.from({ length: 401 }, (_, i) => ({ x: i, y: 1 }));
    expect(explainRequestSchema.safeParse({ ...ok(), context: ctx }).success).toBe(false);
    const r = explainRequestSchema.parse(ok());
    expect(r.context.history.points[0].y).toBe(385);
    const c2 = makeContext({ value: { raw: null, unit: 'u' } });
    expect(explainRequestSchema.parse({ ...ok(), context: c2 }).context.value.raw).toBeNull();
  });
});
