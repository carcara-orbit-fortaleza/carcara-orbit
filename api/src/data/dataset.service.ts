import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CalendarDataset,
  GeoCollection,
  MockDataService,
  RegionInfo,
} from './mock-data.service.js';

export type DataMode = 'mock' | 'real';

export interface DatasetAvailabilityEntry {
  available: boolean;
  updatedAt: string | null;
}

export interface DatasetAvailability {
  mock: DatasetAvailabilityEntry;
  real: DatasetAvailabilityEntry;
}

export interface DatasetSource {
  mode: DataMode;
  dataset: CalendarDataset;
  regionsGeo: GeoCollection;
  recentPoints: GeoCollection;
  hotspots: GeoCollection;
  runMeta: Record<string, unknown> | null;
  dir: string;
}

/**
 * Selects the active dataset (mock or real) and exposes the same shape to the
 * existing calendar/hotspots/meta/export modules.
 */
@Injectable()
export class DatasetService {
  private mode: DataMode;
  private realCache: DatasetSource | null = null;
  private readonly runtimeDir = join(process.cwd(), 'data', 'runtime');
  private readonly modeFile =
    process.env.DATASET_MODE_FILE ?? join(this.runtimeDir, 'mode.json');
  private readonly mockDir = process.env.MOCK_DATA_DIR ?? join(process.cwd(), 'data', 'mock');
  private readonly realDir = process.env.REAL_DATA_DIR ?? join(process.cwd(), 'data', 'real');

  constructor(private readonly mock: MockDataService) {
    this.mode = this.readMode();
  }

  get currentMode(): DataMode {
    return this.mode;
  }

  get dataset(): CalendarDataset {
    return this.active.dataset;
  }

  get regionsGeo(): GeoCollection {
    return this.active.regionsGeo;
  }

  get recentPoints(): GeoCollection {
    return this.active.recentPoints;
  }

  get hotspots(): GeoCollection {
    return this.active.hotspots;
  }

  get runMeta(): Record<string, unknown> | null {
    return this.active.runMeta;
  }

  findRegion(id: string): RegionInfo | undefined {
    return this.dataset.regions.find((region) => region.id === id);
  }

  availability(): DatasetAvailability {
    return {
      mock: this.info(join(this.mockDir, 'calendario.json')),
      real: this.info(join(this.realDir, 'calendario.json')),
    };
  }

  setMode(mode: DataMode): DataMode {
    if (mode !== 'mock' && mode !== 'real') {
      throw new ConflictException('mode must be "mock" or "real"');
    }
    if (mode === 'real' && !this.availability().real.available) {
      throw new ConflictException(
        'Real data is not available yet. Run the pipeline or an NRT refresh first.',
      );
    }
    this.mode = mode;
    mkdirSync(dirname(this.modeFile), { recursive: true });
    writeFileSync(
      this.modeFile,
      `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return this.mode;
  }

  reloadReal(): void {
    this.realCache = null;
  }

  private get active(): DatasetSource {
    return this.mode === 'real' ? this.loadReal() : this.mockSource();
  }

  private mockSource(): DatasetSource {
    return {
      mode: 'mock',
      dataset: this.mock.dataset,
      regionsGeo: this.mock.regionsGeo,
      recentPoints: this.mock.recentPoints,
      hotspots: this.mock.recentPoints,
      runMeta: null,
      dir: this.mockDir,
    };
  }

  private loadReal(): DatasetSource {
    if (this.realCache) return this.realCache;
    const calendarPath = join(this.realDir, 'calendario.json');
    if (!existsSync(calendarPath)) {
      throw new ServiceUnavailableException(
        'No real dataset is available. Run the pipeline or an NRT refresh first.',
      );
    }

    const dataset = this.readJson<CalendarDataset>(calendarPath);
    const recentPoints = this.readOptional<GeoCollection>(
      join(this.realDir, 'pontos-recentes.json'),
      { type: 'FeatureCollection', features: [] },
    );
    const hotspots = this.readOptional<GeoCollection>(
      join(this.realDir, 'hotspots.geojson'),
      recentPoints,
    );
    const regionsGeo = this.readOptional<GeoCollection>(
      join(this.realDir, 'regioes.geojson'),
      this.buildRegionsGeo(dataset.regions),
    );
    const runMeta = this.readOptional<Record<string, unknown> | null>(
      join(this.realDir, 'run-meta.json'),
      null,
    );

    this.realCache = {
      mode: 'real',
      dataset,
      regionsGeo,
      recentPoints,
      hotspots,
      runMeta,
      dir: this.realDir,
    };
    return this.realCache;
  }

  private buildRegionsGeo(regions: RegionInfo[]): GeoCollection {
    return {
      type: 'FeatureCollection',
      features: regions.map((region) => ({
        type: 'Feature',
        properties: {
          id: region.id,
          name: region.name,
          short: region.short,
          biome: region.biome,
          area_km2: region.area_km2,
          color: region.color,
        },
        geometry: { type: 'Polygon', coordinates: [region.polygon] },
      })),
    };
  }

  private readJson<T>(file: string): T {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }

  private readOptional<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    return this.readJson<T>(file);
  }

  private info(file: string): DatasetAvailabilityEntry {
    if (!existsSync(file)) return { available: false, updatedAt: null };
    try {
      return { available: true, updatedAt: statSync(file).mtime.toISOString() };
    } catch {
      return { available: true, updatedAt: null };
    }
  }

  private readMode(): DataMode {
    try {
      const parsed = JSON.parse(readFileSync(this.modeFile, 'utf8')) as { mode?: string };
      if (parsed.mode === 'real' || parsed.mode === 'mock') return parsed.mode;
    } catch {
      // Fall through to env/default.
    }
    const envMode = process.env.DATA_SOURCE;
    return envMode === 'real' || envMode === 'mock' ? envMode : 'mock';
  }
}
