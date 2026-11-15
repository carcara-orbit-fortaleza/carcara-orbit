import { Module } from '@nestjs/common';
import { GlobalController } from './global.controller.js';
import { GlobalIngestionService } from './global-ingestion.service.js';
import { GlobalService } from './global.service.js';

@Module({
  controllers: [GlobalController],
  providers: [GlobalService, GlobalIngestionService],
  exports: [GlobalService, GlobalIngestionService],
})
export class GlobalModule {}
