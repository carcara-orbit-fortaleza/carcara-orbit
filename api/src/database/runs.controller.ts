import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertAdmin } from '../common/admin.js';
import { DatabaseService } from './database.service.js';

@Controller('runs')
export class RunsController {
  constructor(private readonly database: DatabaseService) {}

  /** Histórico operacional persistido no Postgres. */
  @Get()
  async list(@Query('limit') limit: string | undefined, @Req() req: Request) {
    assertAdmin(req);

    const parsed = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new BadRequestException('limit deve ser um inteiro entre 1 e 100');
    }

    return {
      configured: this.database.enabled,
      database: await this.database.status(),
      runs: await this.database.listRuns(parsed),
    };
  }
}
