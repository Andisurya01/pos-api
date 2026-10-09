import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import {
  DB,
  type Database,
  type DbTransaction,
} from '../database/database.module.js';
import {
  rolePermissions,
  roles,
  userRoles,
  users,
} from '../database/schema/index.js';
import { PERMISSION_CODES, type PermissionCode } from './permission-registry.js';
import type { Principal } from './principal.js';

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: PermissionCode[];
}

/**
 * Role management for the Hak Akses page (docs/alur/02). The owner role is never
 * edited here: it always holds every permission, so the system cannot lock itself out.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async create(actor: Principal, input: RoleInput) {
    const permissions = unique(input.permissions);
    return this.db.transaction(async (tx) => {
      await this.assertNameFree(tx, input.name);
      const [role] = await tx
        .insert(roles)
        .values({
          name: input.name,
          description: input.description ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: roles.id, name: roles.name });
      await this.replacePermissions(tx, role.id, permissions);
      await this.audit.log(
        {
          action: 'role.create',
          entityType: 'role',
          entityId: role.id,
          userId: actor.userId,
          after: { name: role.name, permissions },
        },
        tx,
      );
      return { ...role, permissions };
    });
  }

  async update(actor: Principal, id: string, input: RoleInput) {
    const permissions = unique(input.permissions);
    return this.db.transaction(async (tx) => {
      const role = await this.lockRole(tx, id);
      if (role.isOwner) {
        throw new BadRequestException(
          'Role Owner selalu memegang semua izin dan tidak bisa diubah',
        );
      }
      if (input.name !== role.name) await this.assertNameFree(tx, input.name);
      const before = await this.permissionsOf(tx, id);

      await tx
        .update(roles)
        .set({
          name: input.name,
          description: input.description ?? null,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(roles.id, id));
      await this.replacePermissions(tx, id, permissions);
      await this.audit.log(
        {
          action: 'permission.change',
          entityType: 'role',
          entityId: id,
          userId: actor.userId,
          before: { name: role.name, permissions: before },
          after: { name: input.name, permissions },
        },
        tx,
      );
      return { id, name: input.name, permissions };
    });
  }

  /** Built-in roles stay; custom roles can go once no active user holds them. */
  async remove(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const role = await this.lockRole(tx, id);
      if (role.isSystem) {
        throw new BadRequestException('Role bawaan tidak bisa dihapus');
      }
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.roleId, id), eq(users.isActive, true)));
      if (count > 0) {
        throw new ConflictException(
          `Role masih dipakai ${count} pengguna aktif`,
        );
      }
      const before = await this.permissionsOf(tx, id);
      await tx.delete(roles).where(eq(roles.id, id));
      await this.audit.log(
        {
          action: 'role.delete',
          entityType: 'role',
          entityId: id,
          userId: actor.userId,
          before: { name: role.name, permissions: before },
        },
        tx,
      );
    });
  }

  private async lockRole(tx: DbTransaction, id: string) {
    const [role] = await tx
      .select()
      .from(roles)
      .where(eq(roles.id, id))
      .for('update');
    if (!role) throw new NotFoundException('Role tidak ditemukan');
    return role;
  }

  private async assertNameFree(tx: DbTransaction, name: string) {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(sql`lower(${roles.name}) = lower(${name})`);
    if (existing) throw new ConflictException(`Role "${name}" sudah ada`);
  }

  private async permissionsOf(tx: DbTransaction, roleId: string) {
    const rows = await tx
      .select({ code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    return rows.map((r) => r.code).sort();
  }

  private async replacePermissions(
    tx: DbTransaction,
    roleId: string,
    permissions: PermissionCode[],
  ) {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (permissions.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(permissions.map((code) => ({ roleId, permissionCode: code })));
    }
  }
}

function unique(codes: PermissionCode[]) {
  return [...new Set(codes)].sort();
}

/** Exposed for request validation. */
export const isPermissionCode = (code: string): code is PermissionCode =>
  (PERMISSION_CODES as string[]).includes(code);
