import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiLlmClient } from './explain.service.js';

const REQ = {
  model: 'gemini-3.5-flash-lite',
  system: 'SYSTEM_TEXT',
  user: 'USER_TEXT',
  maxTokens: 321,
  timeoutMs: 5_000,
};

function geminiResponse(text: string) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22, totalTokenCount: 133 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('GeminiLlmClient', () => {
  const realKey = process.env.GEMINI_API_KEY;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    fetchMock = vi.fn(async () => geminiResponse('{"answer":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  });

  it('envia modelo, instrução do sistema, teto de saída e raciocínio limitado, e lê os tokens', async () => {
    const out = await new GeminiLlmClient().complete(REQ);

    expect(out).toEqual({ text: '{"answer":"ok"}', inputTokens: 111, outputTokens: 22 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect(String(url)).toContain('gemini-3.5-flash-lite');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('x-goog-api-key')).toBe('test-key-not-real');

    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, any>;
    const raw = JSON.stringify(body);
    expect(raw).toContain('SYSTEM_TEXT');
    expect(raw).toContain('USER_TEXT');
    expect(body.generationConfig.maxOutputTokens).toBe(321);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
  });

  it('falha sem chave, sem chamar a rede', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(new GeminiLlmClient().complete(REQ)).rejects.toThrow('GEMINI_API_KEY missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propaga erro do provedor (o serviço o converte em 502)', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":{"message":"quota"}}', { status: 429 }));
    await expect(new GeminiLlmClient().complete(REQ)).rejects.toThrow();
  });
});
