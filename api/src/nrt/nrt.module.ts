import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { NrtController } from './nrt.controller.js';
import { NrtService } from './nrt.service.js';

@Module({
  imports: [IngestionModule],
  controllers: [NrtController],
  providers: [NrtService],
  exports: [NrtService],
})
export class NrtModule {}
