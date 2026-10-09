import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import {
  DB,
  type Database,
  type DbExecutor,
} from '../database/database.module.js';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '../database/schema/index.js';
import {
  MODULE_LABELS,
  PERMISSION_CODES,
  type PermissionCode,
} from './permission-registry.js';
import type { Principal } from './principal.js';

@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Null when the user is inactive or the session is revoked/expired.
   * Read on every request so permission changes and logouts apply immediately.
   */
  async loadPrincipal(
    userId: string,
    sessionId: string,
  ): Promise<Principal | null> {
    const [row] = await this.db
      .select({
        username: users.username,
        fullName: users.fullName,
        mustChangePassword: users.mustChangePassword,
        terminalId: sessions.terminalId,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          eq(users.isActive, true),
        ),
      );
    if (!row) return null;

    const grants = await this.grantsOfUser(userId);
    return {
      userId,
      sessionId,
      terminalId: row.terminalId,
      username: row.username,
      fullName: row.fullName,
      mustChangePassword: row.mustChangePassword,
      ...grants,
    };
  }

  /** Roles and effective permissions of any user (owners get every code). */
  async grantsOfUser(userId: string, executor: DbExecutor = this.db) {
    const roleRows = await executor
      .select({ name: roles.name, isOwner: roles.isOwner })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    const isOwner = roleRows.some((r) => r.isOwner);

    let codes: PermissionCode[];
    if (isOwner) {
      codes = PERMISSION_CODES;
    } else {
      const permRows = await executor
        .selectDistinct({ code: rolePermissions.permissionCode })
        .from(rolePermissions)
        .innerJoin(userRoles, eq(userRoles.roleId, rolePermissions.roleId))
        .where(eq(userRoles.userId, userId));
      codes = permRows.map((p) => p.code as PermissionCode);
    }
    return {
      isOwner,
      roles: roleRows.map((r) => r.name),
      permissions: new Set(codes) as ReadonlySet<PermissionCode>,
    };
  }

  /** Permission catalogue grouped for the Hak Akses matrix. */
  async listPermissionTree() {
    const rows = await this.db
      .select()
      .from(permissions)
      .orderBy(asc(permissions.sortOrder));
    const modules = new Map<
      string,
      { module: string; label: string; permissions: typeof rows }
    >();
    for (const row of rows) {
      let group = modules.get(row.module);
      if (!group) {
        group = {
          module: row.module,
          label: MODULE_LABELS[row.module] ?? row.module,
          permissions: [],
        };
        modules.set(row.module, group);
      }
      group.permissions.push(row);
    }
    return [...modules.values()];
  }

  async listRoles() {
    const roleRows = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
        isOwner: roles.isOwner,
      })
      .from(roles)
      .orderBy(asc(roles.name));
    const grants = await this.db.select().from(rolePermissions);
    return roleRows.map((role) => ({
      ...role,
      permissions: role.isOwner
        ? PERMISSION_CODES
        : grants
            .filter((g) => g.roleId === role.id)
            .map((g) => g.permissionCode),
    }));
  }
}
