// ERD 01 — Sistem dan Akses (docs/erd/01-sistem-dan-akses.md).
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './columns.js';

/**
 * Standard created/updated columns for master tables and documents.
 * A function so every table gets fresh column builders.
 */
export function auditColumns() {
  return {
    createdAt: timestamptz().notNull().defaultNow(),
    createdBy: uuid().references((): AnyPgColumn => users.id),
    updatedAt: timestamptz().notNull().defaultNow(),
    updatedBy: uuid().references((): AnyPgColumn => users.id),
  };
}

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamptz().notNull().defaultNow(),
  updatedBy: uuid().references((): AnyPgColumn => users.id),
});

export const license = pgTable(
  'license',
  {
    id: smallint().primaryKey().default(1),
    licenseKey: text().notNull(),
    licenseeName: text().notNull(),
    issuedAt: date().notNull(),
    validUntil: date(),
    features: jsonb().notNull().default({}),
    signature: text().notNull(),
    installedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('license_single_row', sql`${t.id} = 1`)],
);

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    username: text().notNull(),
    fullName: text().notNull(),
    passwordHash: text().notNull(),
    mustChangePassword: boolean().notNull().default(false),
    pinHash: text(),
    isActive: boolean().notNull().default(true),
    failedLoginCount: smallint().notNull().default(0),
    lockedUntil: timestamptz(),
    pinFailedCount: smallint().notNull().default(0),
    pinLockedUntil: timestamptz(),
    lastLoginAt: timestamptz(),
    ...auditColumns(),
  },
  (t) => [uniqueIndex('users_username_lower_uq').on(sql`lower(${t.username})`)],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull().unique(),
    description: text(),
    isSystem: boolean().notNull().default(false),
    isOwner: boolean().notNull().default(false),
    ...auditColumns(),
  },
  (t) => [
    // Exactly one owner role may exist; it always holds every permission.
    uniqueIndex('roles_single_owner_uq')
      .on(t.isOwner)
      .where(sql`${t.isOwner}`),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

/** Seeded from the permission registry in code; admins only tick them per role. */
export const permissions = pgTable('permissions', {
  code: text().primaryKey(),
  module: text().notNull(),
  menu: text().notNull(),
  action: text().notNull(),
  label: text().notNull(),
  sortOrder: integer().notNull().default(0),
  isPinApprovable: boolean().notNull().default(false),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text()
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    refreshTokenHash: text().notNull(),
    // FK to terminals is added with the sales schema (ERD 04).
    terminalId: uuid(),
    userAgent: text(),
    ipAddress: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const pinApprovals = pgTable(
  'pin_approvals',
  {
    id: uuid().primaryKey().defaultRandom(),
    permissionCode: text()
      .notNull()
      .references(() => permissions.code),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    approvedBy: uuid()
      .notNull()
      .references(() => users.id),
    terminalId: uuid(),
    entityType: text(),
    entityId: uuid(),
    details: jsonb().notNull().default({}),
    approvedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('pin_approvals_approved_at_idx').on(t.approvedAt),
    index('pin_approvals_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Append-only: UPDATE/DELETE are rejected by a trigger (see custom migration). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamptz().notNull().defaultNow(),
    userId: uuid().references(() => users.id),
    terminalId: uuid(),
    ipAddress: text(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    pinApprovalId: uuid().references(() => pinApprovals.id),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_occurred_at_idx').on(t.occurredAt),
    index('audit_logs_user_idx').on(t.userId, t.occurredAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: uuid().primaryKey(),
    endpoint: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    requestHash: text().notNull(),
    statusCode: smallint().notNull(),
    response: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index('idempotency_keys_created_at_idx').on(t.createdAt)],
);

/** Gapless document numbering: the row is locked FOR UPDATE inside the posting transaction. */
export const documentSequences = pgTable(
  'document_sequences',
  {
    docType: text().notNull(),
    period: char({ length: 4 }).notNull(), // YYMM
    lastNo: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.docType, t.period] })],
);

export const integrityCheckRuns = pgTable(
  'integrity_check_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    runAt: timestamptz().notNull().defaultNow(),
    triggeredBy: uuid().references(() => users.id),
    businessDate: date().notNull(),
    results: jsonb().notNull(),
    passed: boolean().notNull(),
  },
  (t) => [index('integrity_check_runs_date_idx').on(t.businessDate)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    fileName: text().notNull(),
    storagePath: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    ...auditColumns(),
  },
  (t) => [index('attachments_entity_idx').on(t.entityType, t.entityId)],
);
