[English](EXPLAIN.md) · **Português**

# POST /api/explain (nível 3 do "?")

Explica UM ponto de dado do painel com um modelo de linguagem, fundamentado
apenas no `ExplainContext` enviado pelo app web (contrato:
`web/src/painel/explain/types.ts`, espelho em runtime:
`src/explain/explain.schema.ts`; mantenha os dois em sincronia).

## Provedor: Google Gemini (AI Studio)

Usa `@ai-sdk/google` por meio do pacote `ai`, atrás da interface `ExplainLlmClient`
(`GeminiLlmClient` em `explain.service.ts`). Env: `GEMINI_API_KEY`, `EXPLAIN_MODEL`
(padrão `gemini-3.5-flash-lite`). O raciocínio interno é limitado a `low` porque os
tokens de raciocínio compartilham o limite de saída. Não verificado aqui (sem chave
neste ambiente, os testes fazem mock de `fetch`): quais modelos e cotas sua chave
recebe no nível gratuito e se o nível gratuito permite que o Google use o conteúdo
enviado para melhorar seus produtos. Consulte os termos do AI Studio antes de
ativar isso em produção: a pergunta é texto livre digitado pelo usuário, então
avise os usuários para não incluírem dados pessoais.

## Requisição / resposta

Corpo `{ context, question (1..400 chars), locale: 'pt-BR' | 'en' }`, estrito
(chaves desconhecidas rejeitadas, contexto de no máximo 12 KB, arrays com limites).
Resposta 200:
`{ answer, citations[], confidence, insufficient, meta: { model, methodVersion, datasetMode } }`.

Os erros são sempre `{ statusCode, code, message }`:

| Status | code | Quando |
| --- | --- | --- |
| 503 | `explain_disabled` | `GEMINI_API_KEY` não definida ou `EXPLAIN_ENABLED` não é `true` (fail closed; nenhum cliente chega a ser criado) |
| 429 | `rate_limited` | limite por IP: 6/min e 40/hora (`EXPLAIN_RATE_PER_MINUTE`, `EXPLAIN_RATE_PER_HOUR`); conta todas as requisições, inclusive as inválidas |
| 429 | `budget_exhausted` | `EXPLAIN_DAILY_TOKEN_BUDGET` (padrão 200000 tokens) consumido no dia UTC |
| 400 | `invalid_request` | violação do schema |
| 502 | `upstream_error` | erro do provedor ou timeout (20 s, no máximo 1 retry, `maxOutputTokens` 1000) |

## Limites contra abuso de custo e seus limites

- O rate limit é indexado por `req.ip`. Atrás do Traefik + nginx do web, defina
  `EXPLAIN_TRUST_PROXY=1`; sem isso, todos os usuários compartilham um único bucket
  (seguro, mas grosseiro). Os contadores ficam em memória.
- O orçamento diário é um contador em memória por instância: ele zera no restart e,
  com N réplicas, o teto efetivo é N vezes o orçamento. Uma reserva de pior caso é
  feita antes de cada chamada e substituída pelo uso real depois.
- O endpoint é público (sem autenticação). Mantenha `EXPLAIN_ENABLED=false` a menos
  que você aceite essa exposição.

## Fundamentação e defesa contra injeção

`prompt.ts` (`PROMPT_VERSION` versionada) fixa as regras; contexto, valores do
servidor e pergunta vão em blocos delimitados separados, com `<` escapado para que
não possam forjar um delimitador. O servidor sobrepõe valores autoritativos do
`DatasetService` (modo, versão do método/dataset, generated_at e, para uma região
conhecida, fator de calibração, incerteza e confiança) sobre o contexto do cliente.
Após a chamada: as citações devem existir no contexto e os números da resposta devem
ocorrer nele (arredondamento, forma percentual e anos são tolerados); caso contrário,
a confiança cai para `low` e uma observação é anexada. A confiança é limitada a `low`
quando a confiança do dataset é `low`. A resposta é limpa de marcação.
Os logs carregam apenas status, contadores de tokens e latência, nunca a chave, a
pergunta ou o contexto.
