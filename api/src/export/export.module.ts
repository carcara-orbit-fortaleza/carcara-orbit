import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { HotspotsModule } from '../hotspots/hotspots.module.js';
import { ExportController } from './export.controller.js';
import { HotspotsExportController } from './hotspots-export.controller.js';
import { ExportService } from './export.service.js';

@Module({
  imports: [CalendarModule, HotspotsModule],
  controllers: [ExportController, HotspotsExportController],
  providers: [ExportService],
})
export class ExportModule {}
