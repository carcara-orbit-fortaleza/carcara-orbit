import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertAdmin } from '../common/admin.js';
import { IngestionService } from './ingestion.service.js';

@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /**
   * Runs the historical pipeline. Body: {"inputDir":"data/raw"}.
   * Synchronous; intended for local/admin use.
   */
  @Post('run')
  @HttpCode(200)
  run(@Body() body: { inputDir?: string } | undefined, @Req() req: Request) {
    assertAdmin(req);
    return this.ingestion.runHistorical(body?.inputDir);
  }
}
