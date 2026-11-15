import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { DatasetService } from '../data/dataset.service.js';
import { DailyTokenBudget, PerIpDailyBudget, parseBudget, parseIpBudget } from './budget.js';
import type {
  ExplainAskResponse,
  ExplainContextInput,
  ExplainErrorCode,
  ExplainRequestInput,
} from './explain.schema.js';
import {
  citationsOutsideContext,
  parseModelJson,
  stripMarkup,
  ungroundedNumbers,
} from './grounding.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

export const EXPLAIN_LLM_CLIENT = Symbol('EXPLAIN_LLM_CLIENT');

// Folga para o raciocínio "low" do Gemini, que consome tokens do mesmo teto da resposta.
export const MAX_OUTPUT_TOKENS = 1000;
export const REQUEST_TIMEOUT_MS = 20_000;
// Modelo estável e mais barato da família 3.5 segundo a documentação do AI Studio; confirme no seu plano.
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}
export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
/** Abstração do provedor: os testes injetam um mock, nunca a API real. */
export interface ExplainLlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}

/**
 * Cliente Gemini (Google AI Studio) via AI SDK. Só constrói o provedor na primeira chamada
 * (e o serviço só chama quando habilitado). O raciocínio interno do modelo é limitado a "low":
 * os tokens de raciocínio contam no teto de saída e poderiam esgotá-lo antes da resposta.
 */
@Injectable()
export class GeminiLlmClient implements ExplainLlmClient {
  private provider: ReturnType<typeof createGoogleGenerativeAI> | null = null;

  async complete(req: LlmRequest): Promise<LlmResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');
    this.provider ??= createGoogleGenerativeAI({ apiKey });
    const res = await generateText({
      model: this.provider(req.model),
      system: req.system,
      prompt: req.user,
      maxOutputTokens: req.maxTokens,
      maxRetries: 1,
      timeout: req.timeoutMs,
      providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low' } } },
    });
    return {
      text: res.text,
      inputTokens: res.usage.inputTokens ?? 0,
      outputTokens: res.usage.outputTokens ?? 0,
    };
  }
}

export function explainError(
  status: number,
  code: ExplainErrorCode,
  message: string,
): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

const NOTES = {
  'pt-BR': {
    numbers:
      'Nota: alguns números da resposta não constam nos dados do contexto; confira nos dados exibidos.',
    citations: 'Nota: algumas referências do modelo não existem no contexto e foram descartadas.',
    malformed: 'Não foi possível produzir uma resposta confiável a partir dos dados deste painel.',
  },
  en: {
    numbers:
      'Note: some numbers in this answer are not in the context data; check them against the displayed data.',
    citations: 'Note: some references given by the model do not exist in the context and were dropped.',
    malformed: 'A reliable answer could not be produced from this dashboard data.',
  },
} as const;

type Verified = Record<string, unknown>;

@Injectable()
export class ExplainService {
  private readonly logger = new Logger('Explain');
  private readonly budget = new DailyTokenBudget(parseBudget(process.env.EXPLAIN_DAILY_TOKEN_BUDGET));
  private readonly ipBudget = new PerIpDailyBudget(
    parseIpBudget(process.env.EXPLAIN_DAILY_TOKEN_BUDGET_PER_IP, this.budget.limit),
  );

  constructor(
    private readonly dataset: DatasetService,
    @Inject(EXPLAIN_LLM_CLIENT) private readonly llm: ExplainLlmClient,
  ) {}

  isEnabled(): boolean {
    return process.env.EXPLAIN_ENABLED === 'true' && !!process.env.GEMINI_API_KEY;
  }

  get model(): string {
    return process.env.EXPLAIN_MODEL || DEFAULT_MODEL;
  }

  /** Sobrepõe valores autoritativos que o servidor conhece sobre o que o cliente enviou. */
  applyAuthority(ctx: ExplainContextInput): {
    context: ExplainContextInput;
    verified: Verified;
  } {
    const meta = (this.dataset.dataset.meta ?? {}) as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const context = structuredClone(ctx);
    context.source.datasetMode = this.dataset.currentMode;
    context.source.methodVersion = s(meta.method_version);
    context.source.datasetVersion = s(meta.version);

    const verified: Verified = {
      mode: this.dataset.currentMode,
      methodVersion: s(meta.method_version),
      datasetVersion: s(meta.version),
      generated_at: s(meta.generated_at),
      note: 'Authoritative values known by the server; they override the client context.',
    };

    const regionId = ctx.scope.mode === 'region' ? ctx.scope.regionId : null;
    const region = regionId ? this.dataset.findRegion(regionId) : undefined;
    const metrics = this.dataset.dataset.metrics as Record<string, unknown>;
    const regionMetrics = region ? (metrics?.[region.id] as Record<string, unknown> | undefined) : undefined;
    const h = regionMetrics?.harmonization as Record<string, unknown> | undefined;
    if (region && h) {
      const pct = typeof h.uncertainty_pct === 'number' ? h.uncertainty_pct : null;
      const conf = s(h.confidence);
      verified.region = {
        id: region.id,
        calibrationFactor: typeof h.factor_by_region === 'number' ? h.factor_by_region : null,
        uncertaintyPct: pct,
        confidence: conf,
      };
      if (pct !== null) context.uncertainty.pct = pct;
      if (conf !== null) context.uncertainty.confidence = conf;
    }
    return { context, verified };
  }

  async ask(req: ExplainRequestInput, ip = 'unknown'): Promise<ExplainAskResponse> {
    // Fail closed: nada de cliente, orçamento ou prompt sem chave e flag.
    if (!this.isEnabled()) {
      throw explainError(503, 'explain_disabled', 'Explanations are disabled on this server.');
    }
    const { context, verified } = this.applyAuthority(req.context);
    const user = buildUserPrompt({ verified, context, question: req.question, locale: req.locale });

    const inputEstimate = Math.ceil((SYSTEM_PROMPT.length + user.length) / 3);
    const reserved = inputEstimate + MAX_OUTPUT_TOKENS;
    // Primeiro o teto por IP (um cliente não esgota o orçamento de todos), depois o global.
    if (!this.ipBudget.reserve(ip, reserved)) {
      this.logger.warn('status=budget_exhausted scope=ip');
      throw explainError(429, 'budget_exhausted', 'The daily explanation budget is exhausted. Try again tomorrow.');
    }
    if (!this.budget.reserve(reserved)) {
      this.ipBudget.settle(ip, reserved, 0);
      this.logger.warn('status=budget_exhausted scope=global');
      throw explainError(429, 'budget_exhausted', 'The daily explanation budget is exhausted. Try again tomorrow.');
    }

    const started = Date.now();
    let result: LlmResult;
    try {
      result = await this.llm.complete({
        model: this.model,
        system: SYSTEM_PROMPT,
        user,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      // Só o tipo do erro: a mensagem do provedor pode ecoar conteúdo.
      // O provedor pode ter cobrado a entrada: mantém ao menos a estimativa de entrada cobrada.
      this.budget.settle(reserved, inputEstimate);
      this.ipBudget.settle(ip, reserved, inputEstimate);
      this.logger.warn(
        `status=upstream_error error=${err instanceof Error ? err.name : 'unknown'} latency_ms=${Date.now() - started}`,
      );
      throw explainError(502, 'upstream_error', 'The explanation service is temporarily unavailable.');
    }
    const actual = result.inputTokens + result.outputTokens;
    this.budget.settle(reserved, actual);
    this.ipBudget.settle(ip, reserved, actual);

    const response = this.finalize(result.text, req, context, verified);
    this.logger.log(
      `status=ok prompt=${PROMPT_VERSION} tokens_in=${result.inputTokens} tokens_out=${result.outputTokens} insufficient=${response.insufficient} confidence=${response.confidence} latency_ms=${Date.now() - started}`,
    );
    return response;
  }

  private finalize(
    text: string,
    req: ExplainRequestInput,
    context: ExplainContextInput,
    verified: Verified,
  ): ExplainAskResponse {
    const notes = NOTES[req.locale];
    const meta = {
      model: this.model,
      methodVersion: context.source.methodVersion,
      datasetMode: context.source.datasetMode,
    };
    const parsed = parseModelJson(text);
    if (!parsed) {
      return { answer: notes.malformed, citations: [], confidence: 'low', insufficient: true, meta };
    }

    let answer = stripMarkup(parsed.answer).slice(0, 1500);
    let confidence = parsed.confidence;
    const root = { ...context, server_verified: verified } as Record<string, unknown>;

    const { valid, invalid } = citationsOutsideContext(parsed.citations, root);
    // A pergunta é entrada não confiável: nunca serve de fonte para fundamentar números.
    const badNumbers = ungroundedNumbers(answer, [context, verified]);
    if (invalid.length) {
      confidence = 'low';
      answer += `\n\n${notes.citations}`;
    }
    if (badNumbers.length) {
      confidence = 'low';
      answer += `\n\n${notes.numbers}`;
    }
    // A autoavaliação do modelo nunca supera a confiança do dataset.
    if (context.uncertainty.confidence === 'low') confidence = 'low';

    return { answer, citations: valid, confidence, insufficient: parsed.insufficient, meta };
  }
}
