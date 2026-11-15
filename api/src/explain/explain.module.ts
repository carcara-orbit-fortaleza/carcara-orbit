import { ExecutionContext, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ExplainController, ExplainEnabledGuard } from './explain.controller.js';
import { GeminiLlmClient, EXPLAIN_LLM_CLIENT, ExplainService, explainError } from './explain.service.js';

const int = (raw: string | undefined, def: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
};

/** Guard global, mas só atua em /api/explain (os outros endpoints não são afetados). */
@Injectable()
export class ExplainThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    // req.ip respeita 'trust proxy' (EXPLAIN_TRUST_PROXY), nunca lemos X-Forwarded-For à mão.
    return String(req.ip ?? 'unknown');
  }
  protected override async throwThrottlingException(_ctx: ExecutionContext): Promise<void> {
    throw explainError(429, 'rate_limited', 'Too many requests. Please wait before asking again.');
  }
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      // Fábrica: lê o env na criação do módulo, não no import.
      useFactory: () => ({
        throttlers: [
          { name: 'minute', ttl: 60_000, limit: int(process.env.EXPLAIN_RATE_PER_MINUTE, 6) },
          { name: 'hour', ttl: 3_600_000, limit: int(process.env.EXPLAIN_RATE_PER_HOUR, 40) },
        ],
        skipIf: (ctx: ExecutionContext) => ctx.getClass() !== ExplainController,
      }),
    }),
  ],
  controllers: [ExplainController],
  providers: [
    ExplainService,
    ExplainEnabledGuard,
    GeminiLlmClient,
    { provide: EXPLAIN_LLM_CLIENT, useExisting: GeminiLlmClient },
    { provide: APP_GUARD, useClass: ExplainThrottlerGuard },
  ],
})
export class ExplainModule {}
