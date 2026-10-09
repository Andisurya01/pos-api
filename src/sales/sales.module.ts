import { Module } from '@nestjs/common';
import { RegistersService } from './registers.service.js';
import { SalesController } from './sales.controller.js';
import { ShiftsService } from './shifts.service.js';

@Module({
  controllers: [SalesController],
  providers: [RegistersService, ShiftsService],
  exports: [ShiftsService],
})
export class SalesModule {}
