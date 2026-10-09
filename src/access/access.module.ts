import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.js';
import { AccessSeedService } from './access-seed.service.js';
import { AccessController } from './access.controller.js';
import { AccessService } from './access.service.js';
import { AuthGuard } from './auth.guard.js';
import { PinService } from './pin.service.js';
import { RolesService } from './roles.service.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          expiresIn: config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AccessController],
  providers: [
    AccessService,
    AccessSeedService,
    RolesService,
    PinService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AccessService, PinService],
})
export class AccessModule {}
