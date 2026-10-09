import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { AccessTokenPayload } from '../access/auth.guard.js';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import type { Env } from '../config/env.js';
import {
  DB,
  type Database,
  type DbTransaction,
} from '../database/database.module.js';
import { roles, sessions, userRoles, users } from '../database/schema/index.js';
import {
  createRefreshToken,
  getDummyHash,
  hashSecret,
  parseRefreshToken,
  secretMatches,
  verifySecret,
} from './credentials.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface ClientMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface LoginInput {
  username: string;
  password: string;
  terminalId?: string;
}

const INVALID_CREDENTIALS = 'Username atau kata sandi salah';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput, meta: ClientMeta) {
    // Failure bookkeeping must commit, so the transaction returns an outcome
    // and the HTTP error is thrown after it.
    const outcome = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = lower(${input.username})`)
        .for('update');

      if (!user) {
        await verifySecret(await getDummyHash(), input.password);
        return { kind: 'invalid' } as const;
      }
      const now = new Date();
      if (user.lockedUntil && user.lockedUntil > now) {
        return { kind: 'locked', until: user.lockedUntil } as const;
      }
      if (!user.isActive) return { kind: 'inactive' } as const;

      if (!(await verifySecret(user.passwordHash, input.password))) {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= MAX_FAILED_LOGINS;
        const lockedUntil = lock
          ? new Date(now.getTime() + LOCK_MINUTES * 60_000)
          : null;
        await tx
          .update(users)
          .set({ failedLoginCount: lock ? 0 : failed, lockedUntil })
          .where(eq(users.id, user.id));
        await this.audit.log(
          {
            action: lock ? 'login.locked' : 'login.failed',
            entityType: 'user',
            entityId: user.id,
            userId: user.id,
            ipAddress: meta.ipAddress,
            after: { failedLoginCount: failed },
          },
          tx,
        );
        return lock
          ? ({ kind: 'locked', until: lockedUntil! } as const)
          : ({ kind: 'invalid' } as const);
      }

      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(users.id, user.id));
      const tokens = await this.openSession(
        tx,
        user.id,
        input.terminalId ?? null,
        meta,
      );
      await this.audit.log(
        {
          action: 'login.success',
          entityType: 'user',
          entityId: user.id,
          userId: user.id,
          terminalId: input.terminalId ?? null,
          ipAddress: meta.ipAddress,
        },
        tx,
      );
      return { kind: 'ok', tokens } as const;
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.tokens;
      case 'invalid':
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      case 'inactive':
        throw new UnauthorizedException('Akun ini sudah dinonaktifkan');
      case 'locked':
        throw new HttpException(
          {
            message: `Akun terkunci karena terlalu banyak percobaan gagal. Coba lagi setelah ${LOCK_MINUTES} menit.`,
            lockedUntil: outcome.until.toISOString(),
          },
          HttpStatus.LOCKED,
        );
    }
  }

  /** Rotates the refresh token. A wrong secret on a live session revokes it (token theft). */
  async refresh(refreshToken: string, meta: ClientMeta) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException('Sesi tidak valid');

    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ session: sessions, userActive: users.isActive })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.id, parsed.sessionId))
        .for('update', { of: sessions });
      const now = new Date();
      if (
        !row ||
        row.session.revokedAt ||
        row.session.expiresAt <= now ||
        !row.userActive
      ) {
        return { kind: 'expired' } as const;
      }
      if (!secretMatches(parsed.secret, row.session.refreshTokenHash)) {
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(eq(sessions.id, row.session.id));
        await this.audit.log(
          {
            action: 'session.reuse_detected',
            entityType: 'session',
            entityId: row.session.id,
            userId: row.session.userId,
            ipAddress: meta.ipAddress,
          },
          tx,
        );
        return { kind: 'expired' } as const;
      }

      const { token, secretHash } = createRefreshToken(row.session.id);
      await tx
        .update(sessions)
        .set({
          refreshTokenHash: secretHash,
          expiresAt: this.sessionExpiry(row.session.createdAt, now),
        })
        .where(eq(sessions.id, row.session.id));
      return {
        kind: 'ok',
        tokens: await this.signTokens(row.session.userId, row.session.id, token),
      } as const;
    });

    if (outcome.kind !== 'ok') {
      throw new UnauthorizedException('Sesi sudah berakhir, silakan login lagi');
    }
    return outcome.tokens;
  }

  async logout(principal: Principal, meta: ClientMeta) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(sessions.id, principal.sessionId), isNull(sessions.revokedAt)),
        );
      await this.audit.log(
        {
          action: 'logout',
          entityType: 'session',
          entityId: principal.sessionId,
          userId: principal.userId,
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
  }

  /** Also ends the user's other sessions; the current one stays logged in. */
  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
    meta: ClientMeta,
  ) {
    const [user] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, principal.userId));
    if (!user || !(await verifySecret(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Kata sandi saat ini salah');
    }
    const passwordHash = await hashSecret(newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          updatedAt: new Date(),
          updatedBy: principal.userId,
        })
        .where(eq(users.id, principal.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, principal.userId),
            ne(sessions.id, principal.sessionId),
            isNull(sessions.revokedAt),
          ),
        );
      await this.audit.log(
        {
          action: 'password.change',
          entityType: 'user',
          entityId: principal.userId,
          userId: principal.userId,
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
  }

  /** Setup wizard: only allowed while the database has no users at all. */
  async createFirstOwner(
    input: { username: string; fullName: string; password: string },
    meta: ClientMeta,
  ) {
    const passwordHash = await hashSecret(input.password);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('setup-owner'))`);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users);
      if (count > 0) {
        throw new ConflictException('Akun Owner sudah pernah dibuat');
      }
      const [ownerRole] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.isOwner, true));
      if (!ownerRole) {
        throw new InternalServerErrorException('Role Owner belum tersedia');
      }
      const [user] = await tx
        .insert(users)
        .values({
          username: input.username,
          fullName: input.fullName,
          passwordHash,
        })
        .returning({ id: users.id, username: users.username });
      await tx.insert(userRoles).values({ userId: user.id, roleId: ownerRole.id });
      await this.audit.log(
        {
          action: 'setup.owner_created',
          entityType: 'user',
          entityId: user.id,
          userId: user.id,
          ipAddress: meta.ipAddress,
          after: { username: user.username },
        },
        tx,
      );
      return user;
    });
  }

  async needsOwner() {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    return count === 0;
  }

  private async openSession(
    tx: DbTransaction,
    userId: string,
    terminalId: string | null,
    meta: ClientMeta,
  ) {
    const now = new Date();
    const sessionId = crypto.randomUUID();
    const { token, secretHash } = createRefreshToken(sessionId);
    await tx.insert(sessions).values({
      id: sessionId,
      userId,
      refreshTokenHash: secretHash,
      terminalId,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      createdAt: now,
      expiresAt: this.sessionExpiry(now, now),
    });
    return this.signTokens(userId, sessionId, token);
  }

  /** Sliding idle window, capped by the maximum session length. */
  private sessionExpiry(createdAt: Date, now: Date) {
    const idle =
      now.getTime() +
      this.config.get('SESSION_IDLE_MINUTES', { infer: true }) * 60_000;
    const max =
      createdAt.getTime() +
      this.config.get('SESSION_MAX_HOURS', { infer: true }) * 3_600_000;
    return new Date(Math.min(idle, max));
  }

  private async signTokens(userId: string, sessionId: string, refreshToken: string) {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    return {
      accessToken: await this.jwt.signAsync(payload),
      refreshToken,
      expiresIn: this.config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
    };
  }
}
