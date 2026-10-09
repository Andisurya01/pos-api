import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../access/decorators.js';
import { hasPermission, type Principal } from '../access/principal.js';
import { moneySchema, positiveQuantitySchema } from '../common/quantity.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RegistersService } from './registers.service.js';
import { SaleReversalsService } from './sale-reversals.service.js';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';

const terminalSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{2,20}$/, 'Kode laci 2–20 huruf/angka'),
  name: z.string().trim().min(1).max(50),
  salesLocationId: z.uuid(),
  defaultFloat: moneySchema.default(0),
  customerDisplayEnabled: z.boolean().default(false),
  printerConfig: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().default(true),
});
const paymentMethodSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(50),
  kind: z.enum(['CASH', 'QRIS', 'CARD', 'TRANSFER']),
  accountId: z.uuid().nullish(),
  requiresReference: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});
const openSchema = z.object({ id: z.uuid(), terminalId: z.uuid(), openingFloat: moneySchema.optional() });
const movementSchema = z.object({ kind: z.enum(['CASH_IN', 'CASH_OUT']), amount: moneySchema, reason: z.string().trim().min(1, 'Alasan wajib diisi').max(200) });
const drawerSchema = z.object({ reason: z.string().trim().min(1).max(200), pinApprovalId: z.uuid().nullish() });
const closeSchema = z.object({
  countedCash: moneySchema,
  depositAmount: moneySchema,
  differenceReason: z.string().trim().max(500).nullish(),
  cashDenominations: z.record(z.string(), z.number().int().min(0)).nullish(),
  noncashSummary: z.record(z.string(), z.unknown()).nullish(),
});

const pinOnly = z.object({ pinApprovalId: z.uuid().nullish() });
const saleSchema = z.object({
  id: z.uuid(),
  memberId: z.uuid().nullish(),
  lines: z
    .array(
      z.object({
        skuUnitId: z.uuid(),
        qty: positiveQuantitySchema,
        scannedCode: z.string().trim().max(64).nullish(),
        overrideUnitPrice: moneySchema.nullish(),
        priceOverridePinId: z.uuid().nullish(),
      }),
    )
    .min(1, 'Keranjang kosong'),
  manualDiscount: moneySchema.default(0),
  manualDiscountPinId: z.uuid().nullish(),
  stockPinApprovalId: z.uuid().nullish(),
  payments: z.array(z.object({ methodId: z.uuid(), amount: moneySchema, referenceNo: z.string().trim().max(64).nullish() })).min(1, 'Isi pembayaran'),
});
const voidSchema = z.object({ reason: z.string().trim().min(1, 'Alasan wajib diisi').max(200), pinApprovalId: z.uuid().nullish() });
const returnSchema = z.object({
  id: z.uuid(),
  saleId: z.uuid(),
  reason: z.string().trim().min(1, 'Alasan wajib diisi').max(200),
  pinApprovalId: z.uuid().nullish(),
  lines: z.array(z.object({ saleLineId: z.uuid(), baseQty: positiveQuantitySchema, condition: z.enum(['SELLABLE', 'DAMAGED']) })).min(1),
  refunds: z.array(z.object({ methodId: z.uuid(), amount: moneySchema, referenceNo: z.string().trim().max(64).nullish() })).default([]),
});
const holdSchema = z.object({ id: z.uuid(), label: z.string().trim().max(50).nullish(), memberId: z.uuid().nullish(), cart: z.array(z.unknown()).min(1) });

@Controller()
export class SalesController {
  constructor(
    private readonly registers: RegistersService,
    private readonly shifts: ShiftsService,
    private readonly salesSvc: SalesService,
    private readonly reversals: SaleReversalsService,
  ) {}

  @Get('terminals')
  @RequireAnyPermission('penjualan.kasir.lihat', 'pengaturan.perangkat.ubah')
  listTerminals() {
    return this.registers.listTerminals();
  }

  @Post('terminals')
  @RequirePermission('pengaturan.perangkat.ubah')
  createTerminal(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(terminalSchema)) b: z.infer<typeof terminalSchema>) {
    return this.registers.createTerminal(a, b);
  }

  @Put('terminals/:id')
  @RequirePermission('pengaturan.perangkat.ubah')
  updateTerminal(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(terminalSchema)) b: z.infer<typeof terminalSchema>) {
    return this.registers.updateTerminal(a, id, b);
  }

  @Get('payment-methods')
  @RequireAnyPermission('penjualan.kasir.lihat', 'pengaturan.perangkat.ubah')
  listPaymentMethods() {
    return this.registers.listPaymentMethods();
  }

  @Post('payment-methods')
  @RequirePermission('pengaturan.perangkat.ubah')
  createPaymentMethod(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(paymentMethodSchema)) b: z.infer<typeof paymentMethodSchema>) {
    return this.registers.savePaymentMethod(a, b);
  }

  @Put('payment-methods/:id')
  @RequirePermission('pengaturan.perangkat.ubah')
  updatePaymentMethod(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(paymentMethodSchema)) b: z.infer<typeof paymentMethodSchema>) {
    return this.registers.savePaymentMethod(a, b, id);
  }

  @Post('shifts/open')
  @RequirePermission('penjualan.shift.buka')
  openShift(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(openSchema)) b: z.infer<typeof openSchema>) {
    return this.shifts.open(a, b);
  }

  @Get('shifts/current')
  @RequirePermission('penjualan.kasir.lihat')
  currentShift(@CurrentPrincipal() a: Principal) {
    return this.shifts.current(a);
  }

  @Get('shifts/:id')
  @RequireAnyPermission('penjualan.kasir.lihat', 'laporan.kontrol.lihat')
  shift(@Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.summary(id);
  }

  @Post('shifts/:id/cash-movements')
  @RequireAnyPermission('penjualan.shift.kas_masuk', 'penjualan.shift.kas_keluar')
  cashMovement(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(movementSchema)) b: z.infer<typeof movementSchema>) {
    const needed = b.kind === 'CASH_IN' ? 'penjualan.shift.kas_masuk' : 'penjualan.shift.kas_keluar';
    if (!hasPermission(a, needed)) {
      throw new ForbiddenException({ message: 'Anda tidak punya izin untuk aksi ini', missingPermissions: [needed] });
    }
    return this.shifts.cashMovement(a, id, b);
  }

  @Post('shifts/:id/open-drawer')
  @RequirePermission('penjualan.kasir.lihat')
  openDrawer(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(drawerSchema)) b: z.infer<typeof drawerSchema>) {
    return this.shifts.openDrawer(a, id, b);
  }

  @Post('shifts/:id/close')
  @RequireAnyPermission('penjualan.shift.tutup', 'penjualan.shift.tutup_paksa')
  closeShift(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(closeSchema)) b: z.infer<typeof closeSchema>) {
    return this.shifts.close(a, id, b);
  }

  @Post('sales')
  @RequirePermission('penjualan.transaksi.buat')
  postSale(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(saleSchema)) b: z.infer<typeof saleSchema>) {
    return this.salesSvc.post(a, b);
  }

  @Get('sales/:id')
  @RequireAnyPermission('penjualan.kasir.lihat', 'laporan.penjualan.lihat')
  sale(@Param('id', ParseUUIDPipe) id: string) {
    return this.salesSvc.detail(id);
  }

  /** [PIN] actions: the service asks for the supervisor approval when the cashier lacks the permission. */
  @Post('sales/:id/reprint')
  @RequirePermission('penjualan.kasir.lihat')
  reprint(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(pinOnly)) b: z.infer<typeof pinOnly>) {
    return this.salesSvc.reprint(a, id, b.pinApprovalId);
  }

  @Post('sales/:id/void')
  @RequirePermission('penjualan.kasir.lihat')
  voidSale(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(voidSchema)) b: z.infer<typeof voidSchema>) {
    return this.reversals.voidSale(a, id, b);
  }

  @Post('sales-returns')
  @RequirePermission('penjualan.kasir.lihat')
  returnSale(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(returnSchema)) b: z.infer<typeof returnSchema>) {
    return this.reversals.returnSale(a, b);
  }

  @Post('held-sales')
  @RequirePermission('penjualan.transaksi.buat')
  hold(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(holdSchema)) b: z.infer<typeof holdSchema>) {
    return this.salesSvc.hold(a, b);
  }

  @Get('held-sales')
  @RequirePermission('penjualan.kasir.lihat')
  listHeld(@CurrentPrincipal() a: Principal) {
    return this.salesSvc.listHeld(a);
  }

  @Delete('held-sales/:id')
  @HttpCode(204)
  @RequirePermission('penjualan.transaksi.buat')
  async releaseHeld(@Param('id', ParseUUIDPipe) id: string) {
    await this.salesSvc.releaseHeld(id);
  }
}
