import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { hashSecret } from '../auth/credentials.js';
import {
  DB,
  type Database,
  type DbTransaction,
} from '../database/database.module.js';
import { roles, sessions, userRoles, users } from '../database/schema/index.js';

export interface CreateUserInput {
  username: string;
  fullName: string;
  temporaryPassword: string;
  roleIds: string[];
}

export interface UpdateUserInput {
  fullName: string;
  roleIds: string[];
}

/**
 * Users are never deleted, only deactivated (their names stay on old documents).
 * Rules that keep the store from locking itself out:
 * - only an owner can grant or remove the Owner role;
 * - the last active owner cannot lose the role or be deactivated.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
        hasPin: sql<boolean>`${users.pinHash} is not null`,
        lockedUntil: users.lockedUntil,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(asc(users.fullName));
    const roleRows = await this.db
      .select({ userId: userRoles.userId, id: roles.id, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId));
    return rows.map((u) => ({
      ...u,
      roles: roleRows
        .filter((r) => r.userId === u.id)
        .map(({ id, name }) => ({ id, name })),
    }));
  }

  async create(actor: Principal, input: CreateUserInput) {
    const passwordHash = await hashSecret(input.temporaryPassword);
    return this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${input.username})`);
      if (taken) throw new ConflictException('Username sudah dipakai');
      const roleIds = await this.checkRoles(tx, actor, input.roleIds, []);

      const [user] = await tx
        .insert(users)
        .values({
          username: input.username,
          fullName: input.fullName,
          passwordHash,
          mustChangePassword: true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: users.id, username: users.username });
      await tx
        .insert(userRoles)
        .values(roleIds.map((roleId) => ({ userId: user.id, roleId })));
      await this.audit.log(
        {
          action: 'user.create',
          entityType: 'user',
          entityId: user.id,
          userId: actor.userId,
          after: { username: user.username, fullName: input.fullName, roleIds },
        },
        tx,
      );
      return user;
    });
  }

  async update(actor: Principal, id: string, input: UpdateUserInput) {
    await this.db.transaction(async (tx) => {
      const user = await this.lockUser(tx, id);
      const currentRoleIds = await this.roleIdsOf(tx, id);
      const roleIds = await this.checkRoles(
        tx,
        actor,
        input.roleIds,
        currentRoleIds,
      );
      if (user.isActive && (await this.losesOwnership(tx, id, roleIds))) {
        await this.assertAnotherActiveOwner(tx, id);
      }

      await tx
        .update(users)
        .set({
          fullName: input.fullName,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(users.id, id));
      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      await tx
        .insert(userRoles)
        .values(roleIds.map((roleId) => ({ userId: id, roleId })));
      await this.audit.log(
        {
          action: 'user.update',
          entityType: 'user',
          entityId: id,
          userId: actor.userId,
          before: { fullName: user.fullName, roleIds: currentRoleIds },
          after: { fullName: input.fullName, roleIds },
        },
        tx,
      );
    });
  }

  /** Temporary password, must be changed at next login; also clears a lockout. */
  async resetPassword(actor: Principal, id: string, temporaryPassword: string) {
    const passwordHash = await hashSecret(temporaryPassword);
    await this.db.transaction(async (tx) => {
      const target = await this.lockUser(tx, id);
      await this.assertCanManage(tx, actor, target.id);
      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(users.id, id));
      await this.revokeSessions(tx, id);
      await this.audit.log(
        {
          action: 'user.reset_password',
          entityType: 'user',
          entityId: id,
          userId: actor.userId,
        },
        tx,
      );
    });
  }

  async setActive(actor: Principal, id: string, active: boolean) {
    if (!active && id === actor.userId) {
      throw new BadRequestException('Tidak bisa menonaktifkan akun sendiri');
    }
    await this.db.transaction(async (tx) => {
      const target = await this.lockUser(tx, id);
      if (target.isActive === active) return;
      await this.assertCanManage(tx, actor, target.id);
      if (!active && (await this.isOwner(tx, id))) {
        await this.assertAnotherActiveOwner(tx, id);
      }
      await tx
        .update(users)
        .set({ isActive: active, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(users.id, id));
      if (!active) await this.revokeSessions(tx, id);
      await this.audit.log(
        {
          action: active ? 'user.activate' : 'user.deactivate',
          entityType: 'user',
          entityId: id,
          userId: actor.userId,
        },
        tx,
      );
    });
  }

  /** The user sets or changes their own supervisor PIN. */
  async setOwnPin(actor: Principal, pin: string) {
    const pinHash = await hashSecret(pin);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ pinHash, pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(users.id, actor.userId));
      await this.audit.log(
        {
          action: 'user.set_pin',
          entityType: 'user',
          entityId: actor.userId,
          userId: actor.userId,
        },
        tx,
      );
    });
  }

  private async lockUser(tx: DbTransaction, id: string) {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for('update');
    if (!user) throw new NotFoundException('Pengguna tidak ditemukan');
    return user;
  }

  private async roleIdsOf(tx: DbTransaction, userId: string) {
    const rows = await tx
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows.map((r) => r.roleId);
  }

  /** Validates role ids and the "only an owner touches the Owner role" rule. */
  private async checkRoles(
    tx: DbTransaction,
    actor: Principal,
    requested: string[],
    current: string[],
  ) {
    const roleIds = [...new Set(requested)];
    if (roleIds.length === 0) {
      throw new BadRequestException('Pilih minimal satu role');
    }
    const found = await tx
      .select({ id: roles.id, isOwner: roles.isOwner })
      .from(roles)
      .where(inArray(roles.id, roleIds));
    if (found.length !== roleIds.length) {
      throw new BadRequestException('Ada role yang tidak ditemukan');
    }
    const [ownerRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.isOwner, true));
    const touchesOwner =
      ownerRole &&
      roleIds.includes(ownerRole.id) !== current.includes(ownerRole.id);
    if (touchesOwner && !actor.isOwner) {
      throw new ForbiddenException(
        'Hanya Owner yang bisa memberikan atau mencabut role Owner',
      );
    }
    return roleIds;
  }

  /** Non-owners cannot reset or deactivate an owner. */
  private async assertCanManage(
    tx: DbTransaction,
    actor: Principal,
    targetId: string,
  ) {
    if (!actor.isOwner && (await this.isOwner(tx, targetId))) {
      throw new ForbiddenException('Hanya Owner yang bisa mengelola akun Owner');
    }
  }

  private async isOwner(tx: DbTransaction, userId: string) {
    const [row] = await tx
      .select({ id: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, userId), eq(roles.isOwner, true)));
    return Boolean(row);
  }

  private async losesOwnership(
    tx: DbTransaction,
    userId: string,
    newRoleIds: string[],
  ) {
    if (!(await this.isOwner(tx, userId))) return false;
    const [ownerRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.isOwner, true));
    return !newRoleIds.includes(ownerRole.id);
  }

  private async assertAnotherActiveOwner(tx: DbTransaction, userId: string) {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          eq(roles.isOwner, true),
          eq(users.isActive, true),
          ne(users.id, userId),
        ),
      );
    if (count === 0) {
      throw new BadRequestException(
        'Harus selalu ada minimal satu Owner aktif',
      );
    }
  }

  private async revokeSessions(tx: DbTransaction, userId: string) {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
}
