import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { StockModule } from '../stock/stock.module.js';
import { RegistersService } from './registers.service.js';
import { SaleReversalsService } from './sale-reversals.service.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';

@Module({
  imports: [CatalogModule, StockModule],
  controllers: [SalesController],
  providers: [RegistersService, ShiftsService, SalesService, SaleReversalsService],
  exports: [ShiftsService],
})
export class SalesModule {}
