import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertAdmin } from '../common/admin.js';
import { NrtService } from './nrt.service.js';

@Controller('nrt')
export class NrtController {
  constructor(private readonly nrt: NrtService) {}

  @Get('status')
  status() {
    return this.nrt.status();
  }

  @Post('refresh')
  @HttpCode(202)
  refresh(@Req() req: Request) {
    assertAdmin(req);
    return { accepted: true, status: this.nrt.trigger('manual') };
  }
}
