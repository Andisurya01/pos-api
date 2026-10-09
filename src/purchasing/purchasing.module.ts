import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module.js';
import { PaymentsReturnsService } from './payments-returns.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchasingController } from './purchasing.controller.js';
import { ReceiptsBillsService } from './receipts-bills.service.js';

@Module({
  imports: [StockModule],
  controllers: [PurchasingController],
  providers: [PurchaseOrdersService, ReceiptsBillsService, PaymentsReturnsService],
})
export class PurchasingModule {}
