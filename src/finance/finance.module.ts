import { Global, Module } from '@nestjs/common';
import { CashOpsService } from './cash-ops.service.js';
import { DocumentNumberService } from './document-number.service.js';
import { FinanceOpsController } from './finance-ops.controller.js';
import { FinanceSeedService } from './finance-seed.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { JournalService } from './journal.service.js';
import { PeriodsService } from './periods.service.js';

/** Global: every posting module needs JournalService and DocumentNumberService. */
@Global()
@Module({
  controllers: [FinanceController, FinanceOpsController],
  providers: [FinanceService, FinanceSeedService, JournalService, DocumentNumberService, CashOpsService, PeriodsService],
  exports: [JournalService, DocumentNumberService],
})
export class FinanceModule {}
