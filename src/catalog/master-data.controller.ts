import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MasterDataService } from './master-data.service.js';

const nameSchema = z.string().trim().min(1, 'Nama wajib diisi').max(100);
const categorySchema = z.object({
  name: nameSchema,
  parentId: z.uuid().nullish(),
  isActive: z.boolean().default(true),
});
const brandSchema = z.object({ name: nameSchema });
const unitSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: nameSchema,
  allowsDecimal: z.boolean().default(false),
});
const includeInactiveSchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

@Controller()
export class MasterDataController {
  constructor(private readonly master: MasterDataService) {}

  @Get('categories')
  @RequirePermission('produk.produk.lihat')
  listCategories(
    @Query(new ZodValidationPipe(includeInactiveSchema))
    query: z.infer<typeof includeInactiveSchema>,
  ) {
    return this.master.listCategories(query.includeInactive);
  }

  @Post('categories')
  @RequirePermission('produk.kategori.ubah')
  createCategory(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(categorySchema)) body: z.infer<typeof categorySchema>,
  ) {
    return this.master.createCategory(actor, body);
  }

  @Put('categories/:id')
  @RequirePermission('produk.kategori.ubah')
  updateCategory(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(categorySchema)) body: z.infer<typeof categorySchema>,
  ) {
    return this.master.updateCategory(actor, id, body);
  }

  @Get('brands')
  @RequirePermission('produk.produk.lihat')
  listBrands() {
    return this.master.listBrands();
  }

  @Post('brands')
  @RequirePermission('produk.kategori.ubah')
  createBrand(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(brandSchema)) body: z.infer<typeof brandSchema>,
  ) {
    return this.master.saveBrand(actor, body);
  }

  @Put('brands/:id')
  @RequirePermission('produk.kategori.ubah')
  updateBrand(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(brandSchema)) body: z.infer<typeof brandSchema>,
  ) {
    return this.master.saveBrand(actor, body, id);
  }

  @Get('units')
  @RequirePermission('produk.produk.lihat')
  listUnits() {
    return this.master.listUnits();
  }

  @Post('units')
  @RequirePermission('produk.kategori.ubah')
  createUnit(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(unitSchema)) body: z.infer<typeof unitSchema>,
  ) {
    return this.master.saveUnit(actor, body);
  }

  @Put('units/:id')
  @RequirePermission('produk.kategori.ubah')
  updateUnit(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(unitSchema)) body: z.infer<typeof unitSchema>,
  ) {
    return this.master.saveUnit(actor, body, id);
  }
}
