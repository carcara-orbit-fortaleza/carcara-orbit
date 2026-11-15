import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertAdmin } from '../common/admin.js';
import {
  GlobalIngestionService,
  type GlobalIngestOptions,
} from './global-ingestion.service.js';
import { GlobalService } from './global.service.js';

@Controller('global')
export class GlobalController {
  constructor(
    private readonly global: GlobalService,
    private readonly ingestion: GlobalIngestionService,
  ) {}

  /** Database coverage, grid metadata and ingestion state. */
  @Get('status')
  status() {
    return {
      ...this.global.status(),
      ingestion: this.ingestion.status(),
    };
  }

  /** Grid cells with global hotspots. */
  @Get('regions')
  regions(
    @Query('bbox') bbox?: string,
    @Query('limit') limit?: string,
  ) {
    return this.global.listRegions({ bbox, limit });
  }

  /** Grid cells as GeoJSON polygons. */
  @Get('regions.geojson')
  regionsGeoJson(
    @Query('bbox') bbox?: string,
    @Query('limit') limit?: string,
  ) {
    return this.global.regionsGeoJson({ bbox, limit });
  }

  /**
   * Monthly calendar for a grid cell or arbitrary bbox.
   * Examples: /api/global/calendar?region=g_s30_w60&from=2000&to=2026
   *           /api/global/calendar?bbox=-74,-34,-34,6
   */
  @Get('calendar')
  calendar(
    @Query('region') region?: string,
    @Query('bbox') bbox?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.global.calendar({ region, bbox, from, to });
  }

  /** Global hotspot search by grid cell or bbox. */
  @Get('hotspots')
  hotspots(
    @Query('region') region?: string,
    @Query('bbox') bbox?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sensor') sensor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.global.hotspots({ region, bbox, from, to, sensor, limit });
  }

  /** CSV of the filtered global hotspots. */
  @Get('export/hotspots.csv')
  hotspotsCsv(
    @Query('region') region: string | undefined,
    @Query('bbox') bbox: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('sensor') sensor: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const { filename, body } = this.global.buildHotspotsCsv({
      region,
      bbox,
      from,
      to,
      sensor,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** CSV of the global calendar for a grid cell or bbox. */
  @Get('export/calendar.csv')
  calendarCsv(
    @Query('region') region: string | undefined,
    @Query('bbox') bbox: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const { filename, body } = this.global.buildCalendarCsv({
      region,
      bbox,
      from,
      to,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  /** Current status of the background global ingestion. */
  @Get('ingest/status')
  ingestStatus() {
    return this.ingestion.status();
  }

  /**
   * Starts the worldwide ingestion in the background (HTTP 202).
   * Requires ADMIN_TOKEN when configured.
   */
  @Post('ingest')
  @HttpCode(202)
  ingest(
    @Body() body: GlobalIngestOptions | undefined,
    @Req() req: Request,
  ) {
    assertAdmin(req);
    return this.ingestion.start(body ?? {});
  }

  /** Cancels the running global ingestion. */
  @Post('ingest/cancel')
  @HttpCode(202)
  cancel(@Req() req: Request) {
    assertAdmin(req);
    return this.ingestion.cancel();
  }
}
