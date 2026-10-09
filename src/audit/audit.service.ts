import { Inject, Injectable } from '@nestjs/common';
import { DB, type Database, type DbExecutor } from '../database/database.module.js';
import { auditLogs } from '../database/schema/index.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  userId?: string | null;
  terminalId?: string | null;
  ipAddress?: string | null;
  before?: unknown;
  after?: unknown;
  pinApprovalId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Pass the open transaction so the audit row commits or rolls back with the change. */
  async log(entry: AuditEntry, executor: DbExecutor = this.db) {
    await executor.insert(auditLogs).values({
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      userId: entry.userId ?? null,
      terminalId: entry.terminalId ?? null,
      ipAddress: entry.ipAddress ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      pinApprovalId: entry.pinApprovalId ?? null,
    });
  }
}
