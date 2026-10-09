import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccessService } from './access.service.js';
import { ANY_PERMISSION, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators.js';
import type { PermissionCode } from './permission-registry.js';
import { type AuthedRequest, hasPermission } from './principal.js';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
}

/**
 * Global guard: every route needs a valid access token unless marked @Public(),
 * and must pass @RequirePermission(...) when present.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Belum login');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Sesi tidak valid atau kedaluwarsa');
    }

    const principal = await this.access.loadPrincipal(payload.sub, payload.sid);
    if (!principal) {
      throw new UnauthorizedException('Sesi sudah berakhir');
    }
    request.principal = principal;

    const required =
      this.reflector.getAllAndOverride<PermissionCode[]>(
        REQUIRED_PERMISSIONS,
        targets,
      ) ?? [];
    const missing = required.filter((code) => !hasPermission(principal, code));
    if (missing.length > 0) {
      throw new ForbiddenException({
        message: 'Anda tidak punya izin untuk aksi ini',
        missingPermissions: missing,
      });
    }
    const anyOf =
      this.reflector.getAllAndOverride<PermissionCode[]>(ANY_PERMISSION, targets) ?? [];
    if (anyOf.length > 0 && !anyOf.some((code) => hasPermission(principal, code))) {
      throw new ForbiddenException({
        message: 'Anda tidak punya izin untuk aksi ini',
        missingPermissions: anyOf,
      });
    }
    return true;
  }
}

function extractBearer(header: string | undefined) {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
