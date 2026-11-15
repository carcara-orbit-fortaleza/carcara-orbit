import { Module } from '@nestjs/common';
import { loadEnvFile } from './config/env.js';
import { DataModule } from './data/data.module.js';
import { MetaModule } from './meta/meta.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { HotspotsModule } from './hotspots/hotspots.module.js';
import { ExportModule } from './export/export.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { NrtModule } from './nrt/nrt.module.js';

loadEnvFile();

@Module({
  imports: [
    DataModule,
    MetaModule,
    CalendarModule,
    HotspotsModule,
    ExportModule,
    IngestionModule,
    NrtModule,
  ],
})
export class AppModule {}
