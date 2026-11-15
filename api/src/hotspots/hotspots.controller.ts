import { Controller, Get, Query } from '@nestjs/common';
import { HotspotsService } from './hotspots.service.js';

@Controller('hotspots')
export class HotspotsController {
  constructor(private readonly hotspots: HotspotsService) {}

  /** Focos recentes em GeoJSON, com filtros por região, período, bbox e sensor. */
  @Get()
  list(
    @Query('region') region?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bbox') bbox?: string,
    @Query('sensor') sensor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.hotspots.query({ region, from, to, bbox, sensor, limit });
  }
}
