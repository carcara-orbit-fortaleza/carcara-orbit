import { Module } from '@nestjs/common';
import { loadEnvFile } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { DataModule } from './data/data.module.js';
import { GlobalModule } from './global/global.module.js';
import { MetaModule } from './meta/meta.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { HotspotsModule } from './hotspots/hotspots.module.js';
import { ExportModule } from './export/export.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { NrtModule } from './nrt/nrt.module.js';
import { ExplainModule } from './explain/explain.module.js';

loadEnvFile();

@Module({
  imports: [
    DatabaseModule,
    DataModule,
    GlobalModule,
    MetaModule,
    CalendarModule,
    HotspotsModule,
    ExportModule,
    IngestionModule,
    NrtModule,
    ExplainModule,
  ],
})
export class AppModule {}
