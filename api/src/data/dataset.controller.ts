import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertAdmin } from '../common/admin.js';
import { CalendarDataset } from './mock-data.service.js';
import { DataMode, DatasetService } from './dataset.service.js';

@Controller()
export class DatasetController {
  constructor(private readonly datasets: DatasetService) {}

  /** Mode, availability, active period and regions for API clients. */
  @Get('config')
  config() {
    let dataset: CalendarDataset | null = null;
    try {
      dataset = this.datasets.dataset;
    } catch {
      dataset = null;
    }
    const availability = this.datasets.availability();

    return {
      mode: this.datasets.currentMode,
      availability,
      activePeriod: dataset?.meta?.period ?? null,
      regions:
        dataset?.regions.map((region) => ({
          id: region.id,
          name: region.name,
          short: region.short,
          biome: region.biome,
          color: region.color,
        })) ?? [],
      features: {
        mock: availability.mock.available,
        real: availability.real.available,
        nrt: true,
        exports: true,
        adminTokenRequired: Boolean(process.env.ADMIN_TOKEN),
      },
    };
  }

  @Get('datasets')
  datasetsInfo() {
    return {
      mode: this.datasets.currentMode,
      availability: this.datasets.availability(),
      run: this.datasets.runMeta,
    };
  }

  /** Switch the active dataset. Requires ADMIN_TOKEN when configured. */
  @Post('mode')
  @HttpCode(200)
  setMode(@Body() body: { mode?: string } | undefined, @Req() req: Request) {
    assertAdmin(req);
    if (!body || (body.mode !== 'mock' && body.mode !== 'real')) {
      throw new BadRequestException('Body must be {"mode":"mock"} or {"mode":"real"}');
    }
    const mode = this.datasets.setMode(body.mode as DataMode);
    return {
      mode,
      availability: this.datasets.availability(),
    };
  }
}
