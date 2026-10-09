import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PgErrorFilter } from './pg-error.filter.js';

@Module({
  providers: [{ provide: APP_FILTER, useClass: PgErrorFilter }],
})
export class CommonModule {}
