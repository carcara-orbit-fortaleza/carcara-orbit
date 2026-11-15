import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { EXPLAIN_LLM_CLIENT } from './../src/explain/explain.service.js';
import { makeContext } from './../src/explain/fixtures.js';

// Nunca chama a API real: o cliente do provedor é substituído por um mock.
describe('POST /api/explain (e2e)', () => {
  let app: INestApplication<App>;
  const complete = vi.fn();
  const body = () => ({ context: makeContext(), question: 'Why is confidence low?', locale: 'en' });

  beforeAll(async () => {
    process.env.DATA_SOURCE = 'mock';
    process.env.DATASET_MODE_FILE = join(tmpdir(), `carcara-explain-mode-${Date.now()}.json`);
    process.env.REAL_DATA_DIR = join(tmpdir(), `carcara-explain-real-${Date.now()}`);
    process.env.GLOBAL_DB_PATH = join(tmpdir(), `carcara-explain-global-${Date.now()}.sqlite`);
    process.env.GLOBAL_REGIONS_FILE = join(tmpdir(), `carcara-explain-regions-${Date.now()}.json`);
    process.env.GLOBAL_CALIBRATION_FILE = join(tmpdir(), `carcara-explain-cal-${Date.now()}.json`);
    process.env.GLOBAL_STATUS_FILE = join(tmpdir(), `carcara-explain-status-${Date.now()}.json`);
    process.env.EXPLAIN_RATE_PER_MINUTE = '4';
    process.env.EXPLAIN_ENABLED = 'false';
    delete process.env.GEMINI_API_KEY;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EXPLAIN_LLM_CLIENT)
      .useValue({ complete })
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is disabled (503) without key/flag, even for an invalid body, and never calls the model', async () => {
    const res = await request(app.getHttpServer()).post('/api/explain').send(body());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      statusCode: 503,
      code: 'explain_disabled',
      message: expect.any(String),
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies with invalid_request, answers valid ones, then rate limits', async () => {
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    process.env.EXPLAIN_ENABLED = 'true';
    complete.mockResolvedValue({
      text: JSON.stringify({
        answer: 'The value is 385 hotspots.',
        citations: ['value.raw'],
        confidence: 'medium',
        insufficient: false,
      }),
      inputTokens: 10,
      outputTokens: 10,
    });

    const bad = await request(app.getHttpServer())
      .post('/api/explain')
      .send({ ...body(), question: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');

    const extra = await request(app.getHttpServer())
      .post('/api/explain')
      .send({ ...body(), hack: true });
    expect(extra.status).toBe(400);

    const ok = await request(app.getHttpServer()).post('/api/explain').send(body());
    expect(ok.status).toBe(200);
    expect(ok.body.citations).toEqual(['value.raw']);
    expect(ok.body.meta.datasetMode).toBe('mock'); // overlay do servidor
    expect(complete).toHaveBeenCalledTimes(1);

    // 4 por minuto no total (o 503, bad, extra e ok já contaram 4).
    const limited = await request(app.getHttpServer()).post('/api/explain').send(body());
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
  });

  it('does not rate limit other routes', async () => {
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    }
  });
});
