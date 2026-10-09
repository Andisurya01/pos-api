import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../access/decorators.js';
import { hasPermission, type Principal } from '../access/principal.js';
import { moneySchema } from '../common/quantity.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RegistersService } from './registers.service.js';
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

@Controller()
export class SalesController {
  constructor(
    private readonly registers: RegistersService,
    private readonly shifts: ShiftsService,
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
}
