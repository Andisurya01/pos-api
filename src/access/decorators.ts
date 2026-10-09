import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { PermissionCode } from './permission-registry.js';
import type { AuthedRequest, Principal } from './principal.js';

export const IS_PUBLIC = 'access:isPublic';
export const REQUIRED_PERMISSIONS = 'access:requiredPermissions';

/** Skips authentication (login, health, setup wizard). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The caller must hold every listed permission (owners always pass). */
export const RequirePermission = (...codes: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, codes);

export const ANY_PERMISSION = 'access:anyPermission';

/** The caller must hold at least one of the listed permissions. */
export const RequireAnyPermission = (...codes: PermissionCode[]) =>
  SetMetadata(ANY_PERMISSION, codes);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal) {
      throw new Error('CurrentPrincipal used on a @Public() route');
    }
    return principal;
  },
);
