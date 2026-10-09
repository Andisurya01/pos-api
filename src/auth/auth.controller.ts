import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentPrincipal, Public } from '../access/decorators.js';
import type { Principal } from '../access/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthService, type ClientMeta } from './auth.service.js';
import { passwordSchema } from './credentials.js';

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username wajib diisi'),
  password: z.string().min(1, 'Kata sandi wajib diisi'),
  terminalId: z.uuid().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export function clientMeta(req: Request): ClientMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export function toProfile(principal: Principal) {
  return {
    id: principal.userId,
    username: principal.username,
    fullName: principal.fullName,
    mustChangePassword: principal.mustChangePassword,
    isOwner: principal.isOwner,
    roles: principal.roles,
    permissions: [...principal.permissions],
    terminalId: principal.terminalId,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
  ) {
    return this.auth.login(body, clientMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(refreshSchema))
    body: z.infer<typeof refreshSchema>,
    @Req() req: Request,
  ) {
    return this.auth.refresh(body.refreshToken, clientMeta(req));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() principal: Principal, @Req() req: Request) {
    await this.auth.logout(principal, clientMeta(req));
  }

  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    return toProfile(principal);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: z.infer<typeof changePasswordSchema>,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(
      principal,
      body.currentPassword,
      body.newPassword,
      clientMeta(req),
    );
  }
}
