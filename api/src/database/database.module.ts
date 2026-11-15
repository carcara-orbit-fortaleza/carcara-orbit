import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { RunsController } from './runs.controller.js';

@Global()
@Module({
  controllers: [RunsController],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
