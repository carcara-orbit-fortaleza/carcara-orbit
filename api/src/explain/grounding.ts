import type { ExplainContextInput } from './explain.schema.js';

/** Remove marcação: a saída é sempre texto simples. */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`+)/g, '')
    .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Resolve caminhos como 'formula.steps[1].values.threshold'. */
export function pathExists(root: unknown, path: string): boolean {
  if (!path || path.length > 200 || !/^[A-Za-z0-9_.[\]-]+$/.test(path)) return false;
  const tokens = path.match(/[^.[\]]+|\[\d+\]/g);
  if (!tokens) return false;
  let cur: unknown = root;
  for (const tok of tokens) {
    if (tok.startsWith('[')) {
      const idx = Number(tok.slice(1, -1));
      if (!Array.isArray(cur) || idx >= cur.length) return false;
      cur = cur[idx];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return false;
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return false;
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return true;
}

const NUM_RE = /\d+(?:[.,]\d+)*/g;
/** Número e, se houver, o marcador de percentual logo depois (%, percent, por cento). */
const PCT_NUM_RE = /(\d+(?:[.,]\d+)*)(\s?(?:%|percent\b|por cento\b))?/gi;

function parseNumber(token: string): number | null {
  let t = token;
  // Separador de milhar: 1.234.567 ou 1,234,567 (grupos de 3 dígitos).
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');
  else t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function decimals(token: string): number {
  if (/^\d{1,3}([.,]\d{3})+$/.test(token)) return 0;
  const m = token.match(/[.,](\d+)$/);
  return m ? m[1].length : 0;
}

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') {
    for (const m of value.match(NUM_RE) ?? []) {
      const n = parseNumber(m);
      if (n !== null) out.push(n);
    }
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => collectNumbers(v, out));
}

/**
 * Números do texto que não aparecem nas fontes (contexto e valores verificados; NUNCA a pergunta),
 * tolerando arredondamento. As formas ×100 e ÷100 só valem para números com sinal de % no texto.
 */
export function ungroundedNumbers(answer: string, sources: unknown[]): string[] {
  const known: number[] = [];
  sources.forEach((s) => collectNumbers(s, known));
  const bad: string[] = [];
  for (const m of answer.matchAll(PCT_NUM_RE)) {
    const token = m[1];
    const isPercent = m[2] !== undefined;
    const n = parseNumber(token);
    if (n === null) continue;
    const tol = 0.5 * 10 ** -decimals(token) + 1e-9;
    const ok = known.some((v) => {
      const forms = isPercent ? [v, Math.abs(v), v * 100, v / 100] : [v, Math.abs(v)];
      return forms.some((c) => Math.abs(c - n) <= tol);
    });
    if (!ok) bad.push(token);
  }
  return bad;
}

export function citationsOutsideContext(
  citations: string[],
  root: Record<string, unknown>,
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const c of citations) (pathExists(root, c) ? valid : invalid).push(c);
  return { valid, invalid };
}

/** Extrai e valida defensivamente o JSON do modelo. */
export type ParsedModelAnswer = {
  answer: string;
  citations: string[];
  confidence: 'low' | 'medium' | 'high';
  insufficient: boolean;
};

export function parseModelJson(text: string): ParsedModelAnswer | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.answer !== 'string' || !r.answer.trim()) return null;
  const citations = Array.isArray(r.citations)
    ? r.citations.filter((c): c is string => typeof c === 'string').slice(0, 20)
    : [];
  const confidence =
    r.confidence === 'high' || r.confidence === 'medium' ? r.confidence : 'low';
  return {
    answer: r.answer,
    citations,
    confidence,
    insufficient: r.insufficient === true,
  };
}

export type ContextRoot = ExplainContextInput;
