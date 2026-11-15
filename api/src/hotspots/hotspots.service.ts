import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GeoFeature } from '../data/mock-data.service.js';
import { DatasetService } from '../data/dataset.service.js';
import { parseBbox, parseSensor, parseYearRange } from '../common/query.js';

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50000;

export interface HotspotsQuery {
  region?: string;
  from?: string;
  to?: string;
  bbox?: string;
  sensor?: string;
  limit?: string;
}

@Injectable()
export class HotspotsService {
  private readonly databaseFile =
    process.env.FIRMS_DB_PATH ??
    join(process.env.STORAGE_DIR ?? join(process.cwd(), 'data'), 'db', 'firms.sqlite');

  constructor(private readonly data: DatasetService) {}

  query(params: HotspotsQuery) {
    const range = parseYearRange(params.from, params.to);
    const bbox = parseBbox(params.bbox);
    const sensor = parseSensor(params.sensor);
    const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit deve ser um inteiro entre 1 e ${MAX_LIMIT}`);
    }

    const databaseResult = this.queryDatabase(params, { range, bbox, sensor, limit });
    if (databaseResult) return databaseResult;

    const matches = this.data.hotspots.features.filter((feature) =>
      this.matches(feature, { region: params.region, range, bbox, sensor }),
    );

    return {
      mode: this.data.currentMode,
      type: 'FeatureCollection' as const,
      total: matches.length,
      returned: Math.min(limit, matches.length),
      features: matches.slice(0, limit),
    };
  }

  private queryDatabase(
    params: HotspotsQuery,
    filter: {
      range: { from: number; to: number };
      bbox?: [number, number, number, number];
      sensor?: string;
      limit: number;
    },
  ) {
    if (this.data.currentMode !== 'real') return null;
    if (!existsSync(this.databaseFile)) return null;

    const db = new DatabaseSync(this.databaseFile, { readOnly: true });
    try {
      const total = Number(
        (db.prepare('SELECT COUNT(*) AS count FROM clusters').get() as { count: number }).count,
      );
      if (total === 0) return null;

      const where: string[] = ['year >= ?', 'year <= ?', 'region_id IS NOT NULL'];
      const values: Array<string | number> = [filter.range.from, filter.range.to];
      if (params.region) {
        where.push('region_id = ?');
        values.push(params.region);
      }
      if (filter.sensor === 'MODIS') where.push('has_modis = 1');
      if (filter.sensor === 'VIIRS') where.push('has_viirs = 1');
      if (filter.bbox) {
        where.push('lon >= ?', 'lon <= ?', 'lat >= ?', 'lat <= ?');
        values.push(filter.bbox[0], filter.bbox[2], filter.bbox[1], filter.bbox[3]);
      }

      const clause = where.join(' AND ');
      const count = Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM clusters WHERE ${clause}`).get(...values) as {
            count: number;
          }
        ).count,
      );
      const rows = db
        .prepare(
          `SELECT id, lat, lon, ts_ms, region_id, biome, sensors, platforms,
                  hotspot_count, has_modis, has_viirs, confidence, confidence_class,
                  brightness_k, frp_mw, daynight, qa_flag, instrument, resolution_m
           FROM clusters
           WHERE ${clause}
           ORDER BY ts_ms DESC
           LIMIT ?`,
        )
        .all(...values, filter.limit) as Array<Record<string, unknown>>;

      const methodVersion = this.data.dataset.meta.method_version ?? 'h1.0';
      const features = rows.map((row) => {
        const sensors = JSON.parse((row.sensors as string | null) ?? '[]') as string[];
        const platforms = JSON.parse((row.platforms as string | null) ?? '[]') as string[];
        const sensor = row.has_modis ? 'MODIS' : 'VIIRS';
        const regionMetrics = this.data.dataset.metrics?.[String(row.region_id)] as
          | { harmonization?: { factor_by_region?: number } }
          | undefined;
        const factor = regionMetrics?.harmonization?.factor_by_region ?? 1;
        const ts = new Date(Number(row.ts_ms)).toISOString();
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [Number(row.lon), Number(row.lat)] },
          properties: {
            id: String(row.id),
            date: ts.slice(0, 10),
            ts_utc: ts,
            region_id: row.region_id,
            biome: row.biome,
            sensor,
            sensors,
            platform: platforms[0] ?? null,
            platforms,
            instrument: row.instrument,
            resolution_m: row.resolution_m,
            confidence: row.confidence,
            confidence_class: row.confidence_class,
            brightness_k: row.brightness_k,
            frp_mw: row.frp_mw,
            daynight: row.daynight,
            qa_flag: row.qa_flag,
            harmonized_weight:
              sensor === 'MODIS' ? 1 : Math.round((1 / Number(factor || 1)) * 1000) / 1000,
            hotspot_count: row.hotspot_count,
            method_version: methodVersion,
          },
        };
      });

      return {
        mode: this.data.currentMode,
        type: 'FeatureCollection' as const,
        total: count,
        returned: features.length,
        features,
      };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  private matches(
    feature: GeoFeature,
    filter: {
      region?: string;
      range: { from: number; to: number };
      bbox?: [number, number, number, number];
      sensor?: string;
    },
  ): boolean {
    const props = feature.properties;
    const year = Number(String(props.date).slice(0, 4));
    if (year < filter.range.from || year > filter.range.to) return false;
    if (filter.region && props.region_id !== filter.region) return false;
    if (filter.sensor && props.sensor !== filter.sensor) return false;
    if (filter.bbox) {
      const [lon, lat] = (feature.geometry as { coordinates: number[] }).coordinates;
      const [west, south, east, north] = filter.bbox;
      if (lon < west || lon > east || lat < south || lat > north) return false;
    }
    return true;
  }
}
