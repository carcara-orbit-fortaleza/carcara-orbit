import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // Keep the legacy mock contract independent from the active real mode.
    process.env.DATA_SOURCE = 'mock';
    process.env.DATASET_MODE_FILE = join(tmpdir(), `carcara-app-mode-${Date.now()}.json`);
    process.env.REAL_DATA_DIR = join(tmpdir(), `carcara-app-real-${Date.now()}`);
    process.env.GLOBAL_DB_PATH = join(tmpdir(), `carcara-global-${Date.now()}.sqlite`);
    process.env.GLOBAL_REGIONS_FILE = join(tmpdir(), `carcara-regions-${Date.now()}.json`);
    process.env.GLOBAL_CALIBRATION_FILE = join(
      tmpdir(),
      `carcara-calibration-${Date.now()}.json`,
    );
    process.env.GLOBAL_STATUS_FILE = join(tmpdir(), `carcara-status-${Date.now()}.json`);

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

  it('GET /api/health', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('ok'));
  });

  it('GET /api/regions lists the six biomes', () => {
    return request(app.getHttpServer())
      .get('/api/regions')
      .expect(200)
      .expect((res) => expect(res.body).toHaveLength(6));
  });

  it('GET /api/calendar returns 27 years for the full period', () => {
    return request(app.getHttpServer())
      .get('/api/calendar?region=pantanal')
      .expect(200)
      .expect((res) => {
        expect(res.body.years).toHaveLength(27);
        expect(res.body.counts[0]).toHaveLength(12);
      });
  });

  it('GET /api/calendar rejects an unknown region', () => {
    return request(app.getHttpServer())
      .get('/api/calendar?region=nao-existe')
      .expect(404);
  });

  it('GET /api/hotspots filters by sensor and returns GeoJSON', () => {
    return request(app.getHttpServer())
      .get('/api/hotspots?region=pantanal&sensor=VIIRS&limit=10')
      .expect(200)
      .expect((res) => {
        expect(res.body.type).toBe('FeatureCollection');
        expect(res.body.features.length).toBeLessThanOrEqual(10);
        for (const f of res.body.features) {
          expect(f.properties.sensor).toBe('VIIRS');
        }
      });
  });

  it('GET /api/hotspots rejects an invalid bbox', () => {
    return request(app.getHttpServer())
      .get('/api/hotspots?bbox=1,2,3')
      .expect(400);
  });

  it('GET /api/global/status reports an empty global dataset', () => {
    return request(app.getHttpServer())
      .get('/api/global/status')
      .expect(200)
      .expect((res) => {
        expect(res.body.scope).toBe('global');
        expect(res.body.database.available).toBe(false);
        expect(res.body.ingestion.running).toBe(false);
      });
  });

  it('GET /api/global/regions returns 503 while the global dataset is missing', () => {
    return request(app.getHttpServer()).get('/api/global/regions').expect(503);
  });

  it('GET /api/export.csv returns a BOM, semicolons and 322 rows for the full series', () => {
    return request(app.getHttpServer())
      .get('/api/export.csv?region=cerrado')
      .expect(200)
      .expect('Content-Type', /text\/csv/)
      .expect((res) => {
        const text = res.text;
        expect(text.charCodeAt(0)).toBe(0xfeff);
        const lines = text.trim().split(/\r?\n/);
        expect(lines[0]).toContain(';');
        expect(lines.length - 1).toBe(322);
      });
  });
});
