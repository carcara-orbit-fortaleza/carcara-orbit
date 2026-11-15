import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { DatasetService } from '../data/dataset.service.js';

const startedAt = Date.now();

@Controller()
export class MetaController {
  constructor(
    private readonly data: DatasetService,
    private readonly database: DatabaseService,
  ) {}

  /** Status do serviço (contrato do brief: /api/health). */
  @Get('health')
  async health() {
    const database = await this.database.status();
    if (database.configured && !database.connected) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database,
      });
    }

    return {
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      dataSource: this.data.currentMode,
      database,
    };
  }

  /** Versão do método, fontes e aviso de dados sintéticos (/api/meta). */
  @Get('meta')
  meta() {
    return {
      ...this.data.dataset.meta,
      baselineYears: this.data.dataset.baseline_years,
      years: this.data.dataset.years,
      months: this.data.dataset.months,
      mode: this.data.currentMode,
      run: this.data.runMeta,
    };
  }

  /** Lista das regiões (biomas) com polígono e cores (/api/regions). */
  @Get('regions')
  regions() {
    return this.data.dataset.regions;
  }

  /** Regiões no formato GeoJSON (/api/regions.geojson). */
  @Get('regions.geojson')
  regionsGeo() {
    return this.data.regionsGeo;
  }
}
