import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DEFAULT_MAPPINGS, type MappingKey } from './chart-template.js';
import { FinanceService } from './finance.service.js';

const createAccountSchema = z.object({
  code: z.string().trim().regex(/^\d-\d{4}$/, 'Format kode akun: 1-1234'),
  name: z.string().trim().min(1, 'Nama akun wajib diisi').max(100),
  parentId: z.uuid(),
  isPostable: z.boolean().default(true),
  contra: z.boolean().default(false),
  cashKind: z.enum(['DRAWER', 'CASH', 'PETTY_CASH', 'BANK', 'CLEARING']).nullish(),
});
const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isActive: z.boolean().default(true),
});
const mappingSchema = z.object({ accountId: z.uuid() });
const mappingKeySchema = z
  .string()
  .refine((k): k is MappingKey => k in DEFAULT_MAPPINGS, 'Kunci pemetaan tidak dikenal');
const journalQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('accounts')
  @RequirePermission('keuangan.akun.lihat')
  listAccounts() {
    return this.finance.listAccounts();
  }

  @Post('accounts')
  @RequirePermission('keuangan.akun.ubah')
  createAccount(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(createAccountSchema)) body: z.infer<typeof createAccountSchema>,
  ) {
    return this.finance.createAccount(actor, body);
  }

  @Put('accounts/:id')
  @RequirePermission('keuangan.akun.ubah')
  updateAccount(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: z.infer<typeof updateAccountSchema>,
  ) {
    return this.finance.updateAccount(actor, id, body);
  }

  @Get('account-mappings')
  @RequirePermission('keuangan.akun.lihat')
  listMappings() {
    return this.finance.listMappings();
  }

  @Put('account-mappings/:key')
  @HttpCode(204)
  @RequirePermission('keuangan.akun.ubah')
  async setMapping(
    @CurrentPrincipal() actor: Principal,
    @Param('key', new ZodValidationPipe(mappingKeySchema)) key: MappingKey,
    @Body(new ZodValidationPipe(mappingSchema)) body: z.infer<typeof mappingSchema>,
  ) {
    await this.finance.setMapping(actor, key, body.accountId);
  }

  @Get('periods')
  @RequirePermission('keuangan.jurnal.lihat')
  listPeriods() {
    return this.finance.listPeriods();
  }

  @Get('journals')
  @RequirePermission('keuangan.jurnal.lihat')
  listJournals(@Query(new ZodValidationPipe(journalQuerySchema)) query: z.infer<typeof journalQuerySchema>) {
    return this.finance.listJournals(query);
  }

  @Get('journals/:id')
  @RequirePermission('keuangan.jurnal.lihat')
  journalDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.finance.journalDetail(id);
  }
}
