import type { Request } from 'express';
import type { PermissionCode } from './permission-registry.js';

/** The logged-in user as seen by every request; rebuilt from the database each time. */
export interface Principal {
  userId: string;
  sessionId: string;
  terminalId: string | null;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  isOwner: boolean;
  roles: string[];
  permissions: ReadonlySet<PermissionCode>;
}

export interface AuthedRequest extends Request {
  principal?: Principal;
}

export function hasPermission(principal: Principal, code: PermissionCode) {
  return principal.isOwner || principal.permissions.has(code);
}
