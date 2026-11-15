import { Global, Module } from '@nestjs/common';
import { DatasetController } from './dataset.controller.js';
import { DatasetService } from './dataset.service.js';
import { MockDataService } from './mock-data.service.js';

@Global()
@Module({
  controllers: [DatasetController],
  providers: [MockDataService, DatasetService],
  exports: [MockDataService, DatasetService],
})
export class DataModule {}
