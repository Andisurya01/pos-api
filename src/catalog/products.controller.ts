import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
} from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  barcodesSchema,
  componentsSchema,
  createProductSchema,
  removeTierSchema,
  setPriceSchema,
  skuInputSchema,
  skuListQuerySchema,
  type SkuListQuery,
  unitInputSchema,
  updateProductSchema,
  updateSkuSchema,
} from './products.schemas.js';
import { ProductsService } from './products.service.js';

const lookupSchema = z.object({ code: z.string().trim().min(1) });

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post('products')
  @RequirePermission('produk.produk.buat')
  create(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(createProductSchema)) body: z.infer<typeof createProductSchema>,
  ) {
    return this.products.create(actor, body);
  }

  @Get('products/:id')
  @RequirePermission('produk.produk.lihat')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.detail(id);
  }

  @Put('products/:id')
  @RequirePermission('produk.produk.ubah')
  update(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: z.infer<typeof updateProductSchema>,
  ) {
    return this.products.updateProduct(actor, id, body);
  }

  @Post('products/:id/skus')
  @RequirePermission('produk.produk.buat')
  addSku(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(skuInputSchema)) body: z.infer<typeof skuInputSchema>,
  ) {
    return this.products.addSku(actor, id, body);
  }

  @Get('skus')
  @RequirePermission('produk.produk.lihat')
  listSkus(@Query(new ZodValidationPipe(skuListQuerySchema)) query: SkuListQuery) {
    return this.products.listSkus(query);
  }

  /** Scan or type a code: barcode first, then SKU code. */
  @Get('catalog/lookup')
  @RequireAnyPermission('penjualan.kasir.lihat', 'produk.produk.lihat', 'pembelian.penerimaan.buat')
  lookup(@Query(new ZodValidationPipe(lookupSchema)) query: z.infer<typeof lookupSchema>) {
    return this.products.lookup(query.code);
  }

  @Put('skus/:id')
  @RequirePermission('produk.produk.ubah')
  updateSku(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateSkuSchema)) body: z.infer<typeof updateSkuSchema>,
  ) {
    return this.products.updateSku(actor, id, body);
  }

  @Post('skus/:id/units')
  @RequirePermission('produk.produk.ubah')
  addUnit(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(unitInputSchema)) body: z.infer<typeof unitInputSchema>,
  ) {
    return this.products.addUnit(actor, id, body);
  }

  @Put('skus/:id/components')
  @RequirePermission('produk.bundel.ubah')
  setComponents(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(componentsSchema)) body: z.infer<typeof componentsSchema>,
  ) {
    return this.products.setComponents(actor, id, body.components);
  }

  @Get('skus/:id/price-history')
  @RequirePermission('produk.harga.lihat')
  priceHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.priceHistory(id);
  }

  @Put('sku-units/:id/barcodes')
  @RequirePermission('produk.produk.ubah')
  replaceBarcodes(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(barcodesSchema)) body: z.infer<typeof barcodesSchema>,
  ) {
    return this.products.replaceBarcodes(actor, id, body.barcodes);
  }

  @Post('sku-units/:id/prices')
  @RequirePermission('produk.harga.ubah')
  setPrice(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setPriceSchema)) body: z.infer<typeof setPriceSchema>,
  ) {
    return this.products.setPrice(actor, id, body);
  }

  @Post('sku-units/:id/prices/remove')
  @RequirePermission('produk.harga.ubah')
  removeTier(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(removeTierSchema)) body: z.infer<typeof removeTierSchema>,
  ) {
    return this.products.removeTier(actor, id, body);
  }
}
