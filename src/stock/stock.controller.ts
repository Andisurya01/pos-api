import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../access/decorators.js';
import { hasPermission, type Principal } from '../access/principal.js';
import { positiveQuantitySchema, quantitySchema } from '../common/quantity.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdjustmentsService } from './adjustments.service.js';
import { OpnameService } from './opname.service.js';
import { WarehouseService } from './warehouse.service.js';

const locationSchema = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
  type: z.enum(['STORAGE', 'DISPLAY', 'DAMAGED', 'TRANSIT']),
  parentId: z.uuid().nullish(),
  isActive: z.boolean().default(true),
});

const signedQuantity = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d{1,15}(\.\d{1,3})?$/.test(v), 'Jumlah maksimal 3 angka desimal');

const adjustmentSchema = z.object({
  id: z.uuid(),
  reason: z.enum(['DAMAGED', 'EXPIRED', 'LOST', 'SELF_USE', 'SAMPLE', 'FOUND', 'OPENING']),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        skuId: z.uuid(),
        locationId: z.uuid(),
        qty: signedQuantity,
        batchId: z.uuid().nullish(),
        batchNo: z.string().trim().max(50).nullish(),
        expiryDate: z.iso.date().nullish(),
        unitCost: z
          .union([z.number().min(0), z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)])
          .transform((v) => String(v))
          .nullish(),
      }),
    )
    .min(1),
});

const transferSchema = z.object({
  id: z.uuid(),
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  note: z.string().trim().max(500).nullish(),
  lines: z.array(z.object({ skuId: z.uuid(), batchId: z.uuid().nullish(), qty: positiveQuantitySchema })).min(1),
});

const rejectSchema = z.object({ reason: z.string().trim().min(1, 'Alasan wajib diisi').max(500) });
const balanceQuerySchema = z.object({
  skuId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  includeZero: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
const opnameSchema = z.object({
  id: z.uuid(),
  scopeLocationIds: z.array(z.uuid()).default([]),
  scopeCategoryIds: z.array(z.uuid()).default([]),
  note: z.string().trim().max(500).nullish(),
});
const countsSchema = z.object({
  counts: z
    .array(z.object({ skuId: z.uuid(), locationId: z.uuid(), batchId: z.uuid().nullish(), countedQty: quantitySchema }))
    .min(1),
});
const submitOpnameSchema = z.object({ uncountedPolicy: z.enum(['IGNORE', 'ZERO']).default('IGNORE') });

const cardQuerySchema = z.object({
  skuId: z.uuid(),
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: z.uuid().optional(),
});

@Controller()
export class StockController {
  constructor(
    private readonly warehouse: WarehouseService,
    private readonly adjustments: AdjustmentsService,
    private readonly opnames: OpnameService,
  ) {}

  @Get('locations')
  @RequirePermission('gudang.lokasi.lihat')
  listLocations() {
    return this.warehouse.listLocations();
  }

  @Post('locations')
  @RequirePermission('gudang.lokasi.buat')
  createLocation(@CurrentPrincipal() actor: Principal, @Body(new ZodValidationPipe(locationSchema)) body: z.infer<typeof locationSchema>) {
    return this.warehouse.saveLocation(actor, body);
  }

  @Put('locations/:id')
  @RequirePermission('gudang.lokasi.ubah')
  updateLocation(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(locationSchema)) body: z.infer<typeof locationSchema>,
  ) {
    return this.warehouse.saveLocation(actor, body, id);
  }

  @Post('stock-transfers')
  @RequirePermission('gudang.pemindahan.buat')
  transfer(@CurrentPrincipal() actor: Principal, @Body(new ZodValidationPipe(transferSchema)) body: z.infer<typeof transferSchema>) {
    return this.warehouse.transfer(actor, body);
  }

  /** Penyesuaian (PS) and saldo awal stok (SA); per-reason permissions are checked in the service. */
  @Post('stock-adjustments')
  @RequireAnyPermission('gudang.penyesuaian.buat', 'gudang.saldo_awal.buat')
  createAdjustment(@CurrentPrincipal() actor: Principal, @Body(new ZodValidationPipe(adjustmentSchema)) body: z.infer<typeof adjustmentSchema>) {
    return this.adjustments.createDraft(actor, body);
  }

  @Get('stock-adjustments/:id')
  @RequireAnyPermission('gudang.penyesuaian.lihat', 'gudang.saldo_awal.buat')
  adjustment(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.detail(id);
  }

  @Post('stock-adjustments/:id/submit')
  @RequireAnyPermission('gudang.penyesuaian.buat', 'gudang.saldo_awal.buat')
  submit(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.submit(actor, id);
  }

  @Post('stock-adjustments/:id/approve')
  @RequireAnyPermission('gudang.penyesuaian.setujui', 'gudang.saldo_awal.setujui')
  approve(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.approve(actor, id);
  }

  @Post('stock-adjustments/:id/reject')
  @RequireAnyPermission('gudang.penyesuaian.setujui', 'gudang.saldo_awal.setujui')
  reject(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    return this.adjustments.reject(actor, id, body.reason);
  }

  @Post('stock-adjustments/:id/cancel')
  @RequireAnyPermission('gudang.penyesuaian.buat', 'gudang.saldo_awal.buat')
  cancel(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.cancel(actor, id);
  }

  @Get('stock/balances')
  @RequireAnyPermission('gudang.kartu_stok.lihat', 'laporan.persediaan.lihat')
  balances(@Query(new ZodValidationPipe(balanceQuerySchema)) query: z.infer<typeof balanceQuerySchema>) {
    return this.warehouse.balances(query);
  }

  @Get('stock/card')
  @RequirePermission('gudang.kartu_stok.lihat')
  stockCard(@CurrentPrincipal() actor: Principal, @Query(new ZodValidationPipe(cardQuerySchema)) query: z.infer<typeof cardQuerySchema>) {
    return this.warehouse.stockCard(query, hasPermission(actor, 'produk.harga.lihat_modal'));
  }

  @Post('stock-opnames')
  @RequirePermission('gudang.opname.buat')
  createOpname(@CurrentPrincipal() actor: Principal, @Body(new ZodValidationPipe(opnameSchema)) body: z.infer<typeof opnameSchema>) {
    return this.opnames.create(actor, body);
  }

  @Get('stock-opnames/:id')
  @RequirePermission('gudang.opname.lihat')
  opname(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.opnames.detail(id, hasPermission(actor, 'produk.harga.lihat_modal'));
  }

  @Post('stock-opnames/:id/start')
  @RequirePermission('gudang.opname.buat')
  startOpname(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.opnames.start(actor, id);
  }

  @Put('stock-opnames/:id/counts')
  @RequirePermission('gudang.opname.hitung')
  recordCounts(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(countsSchema)) body: z.infer<typeof countsSchema>,
  ) {
    return this.opnames.recordCounts(actor, id, body.counts);
  }

  @Post('stock-opnames/:id/submit')
  @RequireAnyPermission('gudang.opname.buat', 'gudang.opname.hitung')
  submitOpname(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(submitOpnameSchema)) body: z.infer<typeof submitOpnameSchema>,
  ) {
    return this.opnames.submit(actor, id, body.uncountedPolicy);
  }

  @Post('stock-opnames/:id/reopen')
  @RequirePermission('gudang.opname.setujui')
  reopenOpname(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.opnames.reopen(actor, id);
  }

  @Post('stock-opnames/:id/approve')
  @RequirePermission('gudang.opname.setujui')
  approveOpname(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.opnames.approve(actor, id);
  }

  @Post('stock-opnames/:id/cancel')
  @RequirePermission('gudang.opname.buat')
  cancelOpname(@CurrentPrincipal() actor: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.opnames.cancel(actor, id);
  }
}
