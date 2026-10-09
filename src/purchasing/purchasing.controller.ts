import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { moneySchema, positiveQuantitySchema } from '../common/quantity.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PaymentsReturnsService } from './payments-returns.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { ReceiptsBillsService } from './receipts-bills.service.js';

const poBody = z.object({
  supplierId: z.uuid(),
  orderDate: z.iso.date().optional(),
  expectedDate: z.iso.date().nullish(),
  note: z.string().trim().max(500).nullish(),
  lines: z.array(z.object({ skuUnitId: z.uuid(), qty: positiveQuantitySchema, unitPrice: moneySchema })).min(1),
});
const poCreate = poBody.extend({ id: z.uuid() });
const reasonSchema = z.object({ reason: z.string().trim().min(1, 'Alasan wajib diisi').max(500) });
const poListSchema = z.object({
  supplierId: z.uuid().optional(),
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']).optional(),
});

const receiptSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  poId: z.uuid().nullish(),
  supplierDeliveryNo: z.string().trim().max(50).nullish(),
  overReceiptPinApprovalId: z.uuid().nullish(),
  lines: z
    .array(
      z.object({
        poLineId: z.uuid().nullish(),
        skuUnitId: z.uuid().nullish(),
        qty: positiveQuantitySchema,
        unitPrice: moneySchema.nullish(),
        locationId: z.uuid(),
        batchNo: z.string().trim().max(50).nullish(),
        expiryDate: z.iso.date().nullish(),
      }),
    )
    .min(1),
  bill: z
    .object({
      supplierInvoiceNo: z.string().trim().min(1).max(50),
      taxInvoiceNo: z.string().trim().max(50).nullish(),
      dueDate: z.iso.date().nullish(),
      taxAmount: moneySchema.default(0),
    })
    .nullish(),
});

const billSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  supplierInvoiceNo: z.string().trim().min(1, 'Nomor tagihan supplier wajib diisi').max(50),
  taxInvoiceNo: z.string().trim().max(50).nullish(),
  billDate: z.iso.date().optional(),
  dueDate: z.iso.date().nullish(),
  shippingCost: moneySchema.default(0),
  taxAmount: moneySchema.default(0),
  lines: z.array(z.object({ receiptLineId: z.uuid(), qty: positiveQuantitySchema, unitPrice: moneySchema })).min(1),
});

const paymentSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  paymentDate: z.iso.date().optional(),
  sourceAccountId: z.uuid(),
  bankFee: moneySchema.default(0),
  referenceNo: z.string().trim().max(50).nullish(),
  allocations: z.array(z.object({ billId: z.uuid(), amount: moneySchema })).default([]),
  debitNotes: z.array(z.object({ purchaseReturnId: z.uuid(), billId: z.uuid(), amount: moneySchema })).default([]),
});

const returnSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  fromLocationId: z.uuid(),
  taxAmount: moneySchema.default(0),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        receiptLineId: z.uuid().nullish(),
        skuId: z.uuid().nullish(),
        batchId: z.uuid().nullish(),
        baseQty: positiveQuantitySchema,
        lineAmount: moneySchema.nullish(),
      }),
    )
    .min(1),
});

@Controller()
export class PurchasingController {
  constructor(
    private readonly pos: PurchaseOrdersService,
    private readonly receipts: ReceiptsBillsService,
    private readonly payments: PaymentsReturnsService,
  ) {}

  @Get('purchase-orders')
  @RequirePermission('pembelian.po.lihat')
  listPos(@Query(new ZodValidationPipe(poListSchema)) q: z.infer<typeof poListSchema>) {
    return this.pos.list(q);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('pembelian.po.lihat')
  po(@Param('id', ParseUUIDPipe) id: string) {
    return this.pos.detail(id);
  }

  @Post('purchase-orders')
  @RequirePermission('pembelian.po.buat')
  createPo(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(poCreate)) b: z.infer<typeof poCreate>) {
    return this.pos.create(a, b);
  }

  @Put('purchase-orders/:id')
  @RequirePermission('pembelian.po.ubah')
  updatePo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(poBody)) b: z.infer<typeof poBody>) {
    return this.pos.update(a, id, b);
  }

  @Post('purchase-orders/:id/submit')
  @RequirePermission('pembelian.po.buat')
  submitPo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.submit(a, id);
  }

  @Post('purchase-orders/:id/approve')
  @RequirePermission('pembelian.po.setujui')
  approvePo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.approve(a, id);
  }

  @Post('purchase-orders/:id/reject')
  @RequirePermission('pembelian.po.setujui')
  rejectPo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) {
    return this.pos.reject(a, id, b.reason);
  }

  @Post('purchase-orders/:id/cancel')
  @RequirePermission('pembelian.po.batalkan')
  cancelPo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.cancel(a, id);
  }

  @Post('purchase-orders/:id/close')
  @RequirePermission('pembelian.po.batalkan')
  closePo(@CurrentPrincipal() a: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(reasonSchema)) b: z.infer<typeof reasonSchema>) {
    return this.pos.close(a, id, b.reason);
  }

  /** With a PO: pembelian.penerimaan.buat. Without: penerimaan langsung (checked in the service). */
  @Post('goods-receipts')
  @RequireAnyPermission('pembelian.penerimaan.buat', 'pembelian.penerimaan_langsung.buat')
  receive(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(receiptSchema)) b: z.infer<typeof receiptSchema>) {
    return this.receipts.receive(a, b);
  }

  @Get('goods-receipts/:id')
  @RequirePermission('pembelian.penerimaan.lihat')
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.receiptDetail(id);
  }

  @Post('supplier-bills')
  @RequirePermission('pembelian.tagihan.buat')
  bill(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(billSchema)) b: z.infer<typeof billSchema>) {
    return this.receipts.bill(a, b);
  }

  @Get('supplier-bills/:id')
  @RequirePermission('pembelian.tagihan.lihat')
  billDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.billDetail(id);
  }

  @Get('suppliers/:id/open-bills')
  @RequireAnyPermission('pembelian.tagihan.lihat', 'pembelian.pembayaran.buat')
  openBills(@Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.listOpenBills(id);
  }

  @Post('supplier-payments')
  @RequirePermission('pembelian.pembayaran.buat')
  pay(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(paymentSchema)) b: z.infer<typeof paymentSchema>) {
    return this.payments.pay(a, b);
  }

  @Get('supplier-payments/:id')
  @RequirePermission('pembelian.pembayaran.lihat')
  payment(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.paymentDetail(id);
  }

  /** Simplified for now: posted at once by someone who may both create and approve returns. */
  @Post('purchase-returns')
  @RequirePermission('pembelian.retur.buat', 'pembelian.retur.setujui')
  returnGoods(@CurrentPrincipal() a: Principal, @Body(new ZodValidationPipe(returnSchema)) b: z.infer<typeof returnSchema>) {
    return this.payments.returnGoods(a, b);
  }

  @Get('purchase-returns/:id')
  @RequirePermission('pembelian.retur.lihat')
  purchaseReturn(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.returnDetail(id);
  }
}
