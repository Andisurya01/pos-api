import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { listQuerySchema, type ListQuery } from '../common/pagination.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PartnersService } from './partners.service.js';

const optionalText = z.string().trim().max(200).nullish();

const supplierSchema = z.object({
  code: z.string().trim().min(1, 'Kode wajib diisi').max(30),
  name: z.string().trim().min(1, 'Nama wajib diisi').max(150),
  address: optionalText,
  phone: optionalText,
  contactName: optionalText,
  isPkp: z.boolean().default(false),
  npwp: z.string().trim().max(30).nullish(),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  leadTimeDays: z.number().int().min(0).max(365).default(3),
  isActive: z.boolean().default(true),
});

const memberSchema = z.object({
  phone: z.string().trim().min(1, 'Nomor HP wajib diisi'),
  name: z.string().trim().min(1, 'Nama wajib diisi').max(100),
  cardNo: z.string().trim().max(50).nullish(),
  isActive: z.boolean().default(true),
});

@Controller()
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get('suppliers')
  @RequirePermission('pembelian.supplier.lihat')
  listSuppliers(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    return this.partners.listSuppliers(query);
  }

  @Post('suppliers')
  @RequirePermission('pembelian.supplier.ubah')
  createSupplier(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(supplierSchema)) body: z.infer<typeof supplierSchema>,
  ) {
    return this.partners.saveSupplier(actor, body);
  }

  @Put('suppliers/:id')
  @RequirePermission('pembelian.supplier.ubah')
  updateSupplier(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supplierSchema)) body: z.infer<typeof supplierSchema>,
  ) {
    return this.partners.saveSupplier(actor, body, id);
  }

  @Get('members')
  @RequirePermission('member.member.lihat')
  listMembers(@Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    return this.partners.listMembers(query);
  }

  @Post('members')
  @RequirePermission('member.member.buat')
  createMember(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(memberSchema)) body: z.infer<typeof memberSchema>,
  ) {
    return this.partners.saveMember(actor, body);
  }

  @Put('members/:id')
  @RequirePermission('member.member.ubah')
  updateMember(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(memberSchema)) body: z.infer<typeof memberSchema>,
  ) {
    return this.partners.saveMember(actor, body, id);
  }
}
