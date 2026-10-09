import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { promotionSchema, type PromotionInput, PromotionsService } from './promotions.service.js';

const listSchema = z.object({ status: z.enum(['active', 'all']).default('all') });

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermission('promo.promo.lihat')
  list(@Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>) {
    return this.promotions.list(query.status === 'active');
  }

  @Get(':id')
  @RequirePermission('promo.promo.lihat')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.detail(id);
  }

  @Post()
  @RequirePermission('promo.promo.buat')
  create(
    @CurrentPrincipal() actor: Principal,
    @Body(new ZodValidationPipe(promotionSchema)) body: PromotionInput,
  ) {
    return this.promotions.save(actor, body);
  }

  /** Also used to deactivate (isActive=false); used promos are never deleted. */
  @Put(':id')
  @RequirePermission('promo.promo.ubah')
  update(
    @CurrentPrincipal() actor: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(promotionSchema)) body: PromotionInput,
  ) {
    return this.promotions.save(actor, body, id);
  }
}
