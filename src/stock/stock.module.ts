import { Module } from '@nestjs/common';
import { AdjustmentsService } from './adjustments.service.js';
import { OpnameService } from './opname.service.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';
import { WarehouseService } from './warehouse.service.js';

@Module({
  controllers: [StockController],
  providers: [StockService, AdjustmentsService, WarehouseService, OpnameService],
  exports: [StockService],
})
export class StockModule {}
