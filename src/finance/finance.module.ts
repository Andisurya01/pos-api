import { Global, Module } from '@nestjs/common';
import { DocumentNumberService } from './document-number.service.js';
import { FinanceSeedService } from './finance-seed.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { JournalService } from './journal.service.js';

/** Global: every posting module needs JournalService and DocumentNumberService. */
@Global()
@Module({
  controllers: [FinanceController],
  providers: [FinanceService, FinanceSeedService, JournalService, DocumentNumberService],
  exports: [JournalService, DocumentNumberService],
})
export class FinanceModule {}
