import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { moneySchema } from '../common/quantity.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CashOpsService } from './cash-ops.service.js';
import { PeriodsService } from './periods.service.js';

const text = (max: number) => z.string().trim().min(1, 'Wajib diisi').max(max);
const positive = moneySchema.refine((v) => v > 0, 'Jumlah harus lebih dari 0');
const categorySchema = z.object({ kind: z.enum(['EXPENSE', 'INCOME']), name: text(50), accountId: z.uuid() });
const cashTxSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['OUT', 'IN']),
  categoryId: z.uuid(),
  cashAccountId: z.uuid(),
  amount: positive,
  description: text(200),
});
const transferSchema = z.object({
  id: z.uuid(),
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  amount: positive,
  description: z.string().trim().max(200).nullish(),
});
const settlementSchema = z.object({
  id: z.uuid(),
  paymentMethodId: z.uuid(),
  bankAccountId: z.uuid(),
  settlementDate: z.iso.date().optional(),
  grossAmount: positive,
  mdrAmount: moneySchema.default(0),
});
const manualSchema = z.object({
  id: z.uuid(),
  journalDate: z.iso.date(),
  description: text(200),
  lines: z
    .array(
      z.object({
        accountId: z.uuid(),
        debit: moneySchema.default(0),
        credit: moneySchema.default(0),
        memo: z.string().trim().max(200).nullish(),
      }),
    )
    .min(2),
});
const reasonSchema = z.object({ reason: text(500) });
const periodParam = new ZodValidationPipe(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format periode YYYY-MM'));

@Controller()
export class FinanceOpsController {
  constructor(
    private readonly cash: CashOpsService,
    private readonly periods: PeriodsService,
  ) {}

  @Get('finance-categories')
  @RequireAnyPermission('keuangan.pengeluaran.lihat', 'keuangan.kas_masuk.buat', 'penjualan.shift.kas_keluar')
  categories() {
    return this.cash.listCategories();
  }

  @Post('finance-categories')
  @RequirePermission('keuangan.akun.ubah')
  createCategory(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(categorySchema)) b: z.infer<typeof categorySchema>) {
    return this.cash.createCategory(a, b);
  }

  /** Per-direction and per-account permissions are checked in the service. */
  @Post('cash-transactions')
  @RequireAnyPermission('keuangan.pengeluaran.buat', 'keuangan.kas_masuk.buat', 'penjualan.shift.kas_keluar', 'penjualan.shift.kas_masuk')
  createCashTx(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(cashTxSchema)) b: z.infer<typeof cashTxSchema>) {
    return this.cash.createCashTransaction(a, b);
  }

  @Get('cash-transactions/:id')
  @RequireAnyPermission('keuangan.pengeluaran.lihat', 'penjualan.shift.kas_keluar')
  cashTx(@Param('id', ParseUUIDPipe) id: string) {
    return this.cash.cashTransaction(id);
  }

  @Post('cash-transactions/:id/approve')
  @RequirePermission('keuangan.pengeluaran.setujui')
  approveCashTx(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.approveCashTransaction(a, id);
  }

  @Post('cash-transactions/:id/cancel')
  @RequireAnyPermission('keuangan.pengeluaran.buat', 'keuangan.pengeluaran.setujui')
  cancelCashTx(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.cancelCashTransaction(a, id);
  }

  @Post('cash-transfers')
  @RequirePermission('keuangan.mutasi_kas.buat')
  transfer(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(transferSchema)) b: z.infer<typeof transferSchema>) {
    return this.cash.transfer(a, b);
  }

  @Post('edc-settlements')
  @RequirePermission('keuangan.rekonsiliasi.buat')
  settle(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(settlementSchema)) b: z.infer<typeof settlementSchema>) {
    return this.cash.settle(a, b);
  }

  /** Create or replace a draft (same id). */
  @Put('manual-journals')
  @RequirePermission('keuangan.jurnal.buat')
  saveManual(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(manualSchema)) b: z.infer<typeof manualSchema>) {
    return this.cash.saveManualJournal(a, b);
  }

  @Get('manual-journals/:id')
  @RequirePermission('keuangan.jurnal.lihat')
  manual(@Param('id', ParseUUIDPipe) id: string) {
    return this.cash.manualJournal(id);
  }

  @Post('manual-journals/:id/submit')
  @RequirePermission('keuangan.jurnal.buat')
  submitManual(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.submitManualJournal(a, id);
  }

  @Post('manual-journals/:id/approve')
  @RequirePermission('keuangan.jurnal.setujui')
  approveManual(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.approveManualJournal(a, id);
  }

  @Post('manual-journals/:id/reject')
  @RequirePermission('keuangan.jurnal.setujui')
  rejectManual(
    @CurrentPrincipal() a: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>,
  ) {
    return this.cash.rejectManualJournal(a, id, b.reason);
  }

  @Post('manual-journals/:id/reverse')
  @RequirePermission('keuangan.jurnal.setujui')
  reverseManual(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.reverseManualJournal(a, id);
  }

  @Get('periods/:id')
  @RequirePermission('keuangan.jurnal.lihat')
  period(@Param('id', periodParam) id: string) {
    return this.periods.get(id);
  }

  @Post('periods/:id/close')
  @RequirePermission('keuangan.periode.tutup')
  closePeriod(@CurrentPrincipal() a: Principal, @Param('id', periodParam) id: string) {
    return this.periods.close(a, id);
  }

  @Post('periods/:id/reopen')
  @RequirePermission('keuangan.periode.buka_kembali')
  reopenPeriod(
    @CurrentPrincipal() a: Principal,
    @Param('id', periodParam) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>,
  ) {
    return this.periods.reopen(a, id, b.reason);
  }
}
