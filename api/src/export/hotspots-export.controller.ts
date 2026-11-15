import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ExportService } from './export.service.js';

@Controller('export/hotspots.csv')
export class HotspotsExportController {
  constructor(private readonly exporter: ExportService) {}

  /** CSV dos focos filtrados pela busca atual. */
  @Get()
  csv(
    @Query('region') region: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('sensor') sensor: string | undefined,
    @Query('bbox') bbox: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const { filename, body } = this.exporter.buildHotspotsCsv({
      region,
      from,
      to,
      sensor,
      bbox,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }
}
