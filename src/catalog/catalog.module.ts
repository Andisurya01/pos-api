import { Module } from '@nestjs/common';
import { MasterDataController } from './master-data.controller.js';
import { MasterDataService } from './master-data.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { PromotionsController } from './promotions.controller.js';
import { PromotionsService } from './promotions.service.js';

@Module({
  controllers: [MasterDataController, ProductsController, PromotionsController],
  providers: [MasterDataService, ProductsService, PromotionsService],
  exports: [ProductsService, PromotionsService],
})
export class CatalogModule {}
