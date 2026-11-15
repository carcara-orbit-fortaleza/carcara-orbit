import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ExportService } from './export.service.js';

@Controller('export.csv')
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @Get()
  csv(
    @Query('region') region: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): string {
    if (!region) {
      throw new BadRequestException('region is required');
    }
    const { filename, body } = this.exporter.buildCsv(region, from, to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }
}
