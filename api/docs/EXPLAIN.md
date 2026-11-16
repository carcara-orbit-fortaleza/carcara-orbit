**English** · [Português](EXPLAIN.pt-BR.md)

# POST /api/explain (level 3 of the "?")

Explains ONE dashboard data point with a language model, grounded only in the
`ExplainContext` sent by the web app (contract: `web/src/painel/explain/types.ts`,
runtime mirror: `src/explain/explain.schema.ts`; keep both in sync).

## Provider: Google Gemini (AI Studio)

Uses `@ai-sdk/google` through the `ai` package, behind the `ExplainLlmClient` interface
(`GeminiLlmClient` in `explain.service.ts`). Env: `GEMINI_API_KEY`, `EXPLAIN_MODEL`
(default `gemini-3.5-flash-lite`). Internal reasoning is capped at `low` because reasoning
tokens share the output cap. Not verified here (no key in this environment, tests mock `fetch`):
which models and quotas your key gets on the free tier, and whether the free tier lets Google
use submitted content to improve its products. Check the AI Studio terms before enabling this in
production: the question is free text typed by the user, so tell users not to include personal data.

## Request / response

Body `{ context, question (1..400 chars), locale: 'pt-BR' | 'en' }`, strict (unknown keys
rejected, context at most 12 KB, bounded arrays). Response 200:
`{ answer, citations[], confidence, insufficient, meta: { model, methodVersion, datasetMode } }`.

Errors are always `{ statusCode, code, message }`:

| Status | code | When |
| --- | --- | --- |
| 503 | `explain_disabled` | `GEMINI_API_KEY` unset or `EXPLAIN_ENABLED` is not `true` (fail closed; no client is ever built) |
| 429 | `rate_limited` | per-IP limit: 6/min and 40/hour (`EXPLAIN_RATE_PER_MINUTE`, `EXPLAIN_RATE_PER_HOUR`); counts every request, including invalid ones |
| 429 | `budget_exhausted` | `EXPLAIN_DAILY_TOKEN_BUDGET` (default 200000 tokens) spent for the UTC day |
| 400 | `invalid_request` | schema violation |
| 502 | `upstream_error` | provider error or timeout (20 s, at most 1 retry, `maxOutputTokens` 1000) |

## Cost-abuse limits and their limits

- Rate limit is keyed by `req.ip`. Behind Traefik + the web nginx set `EXPLAIN_TRUST_PROXY=1`;
  with it unset, all users share one bucket (safe but coarse). Counters are in memory.
- The daily budget is an in-memory counter per instance: it resets on restart and, with N
  replicas, the effective cap is N times the budget. A worst-case reservation is taken before each
  call and replaced by real usage afterwards.
- The endpoint is public (no auth). Keep `EXPLAIN_ENABLED=false` unless you accept that exposure.

## Grounding and injection defense

`prompt.ts` (versioned `PROMPT_VERSION`) fixes the rules; context, server values and question go in
separate delimited blocks with `<` escaped so they cannot forge a delimiter. The server overlays
authoritative values from `DatasetService` (mode, method/dataset version, generated_at and, for a
known region, calibration factor, uncertainty and confidence) over the client context. After the
call: citations must exist in the context, numbers in the answer must occur in it (rounding, percent
form and years tolerated), otherwise confidence drops to `low` and a note is appended. Confidence is
capped at `low` when the dataset confidence is `low`. The answer is stripped of markup.
Logs carry only status, token counters and latency, never the key, question or context.
