import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { verifySecret } from '../auth/credentials.js';
import {
  DB,
  type Database,
  type DbTransaction,
} from '../database/database.module.js';
import { pinApprovals, users } from '../database/schema/index.js';
import { AccessService } from './access.service.js';
import {
  PERMISSION_REGISTRY,
  type PermissionCode,
} from './permission-registry.js';
import { hasPermission, type Principal } from './principal.js';

export const MAX_PIN_FAILURES = 3;
export const PIN_LOCK_MINUTES = 5;
/** An approval must be used by the action it was given for within this window. */
export const PIN_APPROVAL_TTL_MINUTES = 5;

const isPinApprovable = (code: PermissionCode) =>
  (PERMISSION_REGISTRY[code] as { pin?: boolean }).pin === true;

/**
 * Supervisor PIN flow (docs/alur/02): the cashier asks, a supervisor who holds the
 * action's permission enters their PIN, and the action document later consumes the
 * approval exactly once.
 */
@Injectable()
export class PinService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** Users who can approve this action and have a PIN set — the cashier's dropdown. */
  async listApprovers(code: PermissionCode) {
    const candidates = await this.db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(and(eq(users.isActive, true), isNotNull(users.pinHash)))
      .orderBy(asc(users.fullName));
    const approvers: typeof candidates = [];
    for (const user of candidates) {
      const grants = await this.access.grantsOfUser(user.id);
      if (grants.isOwner || grants.permissions.has(code)) approvers.push(user);
    }
    return approvers;
  }

  async approve(
    requester: Principal,
    input: {
      permissionCode: PermissionCode;
      approverId: string;
      pin: string;
      details?: Record<string, unknown>;
    },
  ) {
    if (!isPinApprovable(input.permissionCode)) {
      throw new BadRequestException('Aksi ini tidak memakai PIN supervisor');
    }

    const outcome = await this.db.transaction(async (tx) => {
      const [approver] = await tx
        .select()
        .from(users)
        .where(eq(users.id, input.approverId))
        .for('update');
      if (!approver?.isActive || !approver.pinHash) {
        return { kind: 'invalid' } as const;
      }
      const now = new Date();
      if (approver.pinLockedUntil && approver.pinLockedUntil > now) {
        return { kind: 'locked' } as const;
      }
      const grants = await this.access.grantsOfUser(approver.id, tx);
      if (!grants.isOwner && !grants.permissions.has(input.permissionCode)) {
        return { kind: 'not_allowed' } as const;
      }

      if (!(await verifySecret(approver.pinHash, input.pin))) {
        const failed = approver.pinFailedCount + 1;
        const lock = failed >= MAX_PIN_FAILURES;
        await tx
          .update(users)
          .set({
            pinFailedCount: lock ? 0 : failed,
            pinLockedUntil: lock
              ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000)
              : null,
          })
          .where(eq(users.id, approver.id));
        await this.audit.log(
          {
            action: lock ? 'pin.locked' : 'pin.failed',
            entityType: 'user',
            entityId: approver.id,
            userId: requester.userId,
            terminalId: requester.terminalId,
            after: { permissionCode: input.permissionCode },
          },
          tx,
        );
        return lock ? ({ kind: 'locked' } as const) : ({ kind: 'invalid' } as const);
      }

      await tx
        .update(users)
        .set({ pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(users.id, approver.id));
      const [approval] = await tx
        .insert(pinApprovals)
        .values({
          permissionCode: input.permissionCode,
          requestedBy: requester.userId,
          approvedBy: approver.id,
          terminalId: requester.terminalId,
          details: input.details ?? {},
        })
        .returning({ id: pinApprovals.id, approvedAt: pinApprovals.approvedAt });
      return { kind: 'ok', approval, approverName: approver.fullName } as const;
    });

    switch (outcome.kind) {
      case 'ok':
        return {
          pinApprovalId: outcome.approval.id,
          approvedBy: outcome.approverName,
          expiresAt: new Date(
            outcome.approval.approvedAt.getTime() +
              PIN_APPROVAL_TTL_MINUTES * 60_000,
          ).toISOString(),
        };
      case 'invalid':
        throw new UnauthorizedException('PIN salah');
      case 'not_allowed':
        throw new ForbiddenException(
          'Pengguna ini tidak punya izin untuk menyetujui aksi tersebut',
        );
      case 'locked':
        throw new HttpException(
          {
            message: `PIN terkunci ${PIN_LOCK_MINUTES} menit karena terlalu banyak percobaan salah`,
          },
          HttpStatus.LOCKED,
        );
    }
  }

  /**
   * Called inside the action's posting transaction. Returns the approval id to store
   * on the document, or null when the requester holds the permission themselves.
   */
  async authorize(
    tx: DbTransaction,
    requester: Principal,
    code: PermissionCode,
    pinApprovalId: string | null | undefined,
    entity: { type: string; id: string },
  ): Promise<string | null> {
    if (hasPermission(requester, code)) return null;
    if (!pinApprovalId) {
      throw new ForbiddenException({
        message: 'Aksi ini membutuhkan PIN supervisor',
        requiresPin: code,
      });
    }
    const cutoff = new Date(Date.now() - PIN_APPROVAL_TTL_MINUTES * 60_000);
    const [used] = await tx
      .update(pinApprovals)
      .set({ entityType: entity.type, entityId: entity.id })
      .where(
        and(
          eq(pinApprovals.id, pinApprovalId),
          eq(pinApprovals.permissionCode, code),
          eq(pinApprovals.requestedBy, requester.userId),
          isNull(pinApprovals.entityId),
          gt(pinApprovals.approvedAt, cutoff),
        ),
      )
      .returning({ id: pinApprovals.id });
    if (!used) {
      throw new ForbiddenException({
        message: 'Persetujuan PIN tidak berlaku, sudah dipakai, atau kedaluwarsa',
        requiresPin: code,
      });
    }
    return used.id;
  }
}
