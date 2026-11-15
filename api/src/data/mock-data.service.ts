import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RegionInfo {
  id: string;
  name: string;
  short: string;
  biome: string;
  area_km2: number;
  center: [number, number];
  color: string;
  polygon: [number, number][];
}

export type Matrix = (number | null)[][];

export interface RegionCalendar {
  counts: Matrix;
  anomaly_pct: Matrix;
  raw_modis: Matrix;
  raw_viirs: Matrix;
  viirs_share_pct: Matrix;
}

export interface CalendarDataset {
  meta: Record<string, unknown>;
  months: string[];
  years: number[];
  baseline_years: number[];
  regions: RegionInfo[];
  calendar: Record<string, RegionCalendar>;
  series: Record<string, unknown>;
  metrics: Record<string, unknown>;
  insights: Record<string, string[]>;
}

export interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: unknown;
}

export interface GeoCollection {
  type: 'FeatureCollection';
  name?: string;
  features: GeoFeature[];
}

/**
 * Lê os dados sintéticos (mock) do diretório `data/mock`.
 * Defina MOCK_DATA_DIR para apontar para outro diretório.
 * Quando a ingestão FIRMS estiver pronta, este serviço é o ponto de troca da fonte.
 */
@Injectable()
export class MockDataService {
  readonly dataset: CalendarDataset = this.load<CalendarDataset>('calendario.json');
  readonly regionsGeo: GeoCollection = this.load<GeoCollection>('regioes.geojson');
  readonly recentPoints: GeoCollection = this.load<GeoCollection>('pontos-recentes.json');

  findRegion(id: string): RegionInfo | undefined {
    return this.dataset.regions.find((region) => region.id === id);
  }

  private load<T>(file: string): T {
    const dir = process.env.MOCK_DATA_DIR ?? join(process.cwd(), 'data', 'mock');
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
    } catch {
      throw new InternalServerErrorException(
        `Não foi possível ler o arquivo de dados mock ${file} em ${dir}`,
      );
    }
  }
}
