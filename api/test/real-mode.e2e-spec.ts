import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('Real-data mode and exports (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.DATA_SOURCE = 'mock';
    process.env.REAL_DATA_DIR = join(tmpdir(), `carcara-no-real-${Date.now()}`);
    process.env.DATASET_MODE_FILE = join(tmpdir(), `carcara-mode-${Date.now()}.json`);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/config exposes mode and dataset availability', () => {
    return request(app.getHttpServer())
      .get('/api/config')
      .expect(200)
      .expect((res) => {
        expect(res.body.mode).toBe('mock');
        expect(res.body.availability.mock.available).toBe(true);
        expect(res.body.availability.real.available).toBe(false);
        expect(res.body.features.real).toBe(false);
        expect(Array.isArray(res.body.regions)).toBe(true);
      });
  });

  it('GET /api/regions.geojson returns the six AOIs', () => {
    return request(app.getHttpServer())
      .get('/api/regions.geojson')
      .expect(200)
      .expect((res) => {
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features).toHaveLength(6);
      });
  });

  it('POST /api/mode rejects real mode when no real dataset exists', () => {
    return request(app.getHttpServer())
      .post('/api/mode')
      .send({ mode: 'real' })
      .expect(409)
      .expect((res) => expect(res.body.message).toContain('Real data'));
  });

  it('POST /api/mode switches back to mock', () => {
    return request(app.getHttpServer())
      .post('/api/mode')
      .send({ mode: 'mock' })
      .expect(200)
      .expect((res) => expect(res.body.mode).toBe('mock'));
  });

  it('GET /api/export/hotspots.csv exports the filtered search', () => {
    return request(app.getHttpServer())
      .get('/api/export/hotspots.csv?region=pantanal&from=2025&to=2026&sensor=MODIS')
      .expect(200)
      .expect('Content-Type', /text\/csv/)
      .expect((res) => {
        const text = res.text;
        expect(text.charCodeAt(0)).toBe(0xfeff);
        expect(text).toContain('lat;lon;date;ts_utc');
        const lines = text.trim().split(/\r?\n/);
        expect(lines.length).toBeGreaterThan(1);
      });
  });

  it('GET /api/nrt/status reports the scheduler contract', () => {
    return request(app.getHttpServer())
      .get('/api/nrt/status')
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.enabled).toBe('boolean');
        expect(typeof res.body.running).toBe('boolean');
        expect(typeof res.body.keyConfigured).toBe('boolean');
      });
  });
});
