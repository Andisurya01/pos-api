import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from './access/access.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CommonModule } from './common/common.module.js';
import { validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { HealthController } from './health/health.controller.js';
import { PartnersModule } from './partners/partners.module.js';
import { PurchasingModule } from './purchasing/purchasing.module.js';
import { SalesModule } from './sales/sales.module.js';
import { StockModule } from './stock/stock.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    CommonModule,
    AuditModule,
    AccessModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    PartnersModule,
    FinanceModule,
    StockModule,
    PurchasingModule,
    SalesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
