import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ilike, or, type SQL, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import {
  likePattern,
  type ListQuery,
  offsetOf,
  paginated,
} from '../common/pagination.js';
import { DB, type Database } from '../database/database.module.js';
import { members, suppliers } from '../database/schema/index.js';
import { normalizePhone } from './phone.js';

export interface SupplierInput {
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  contactName?: string | null;
  isPkp: boolean;
  npwp?: string | null;
  paymentTermDays: number;
  leadTimeDays: number;
  isActive: boolean;
}

export interface MemberInput {
  phone: string;
  name: string;
  cardNo?: string | null;
  isActive: boolean;
}

/** Suppliers and members: simple master data, deactivated rather than deleted. */
@Injectable()
export class PartnersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async listSuppliers(query: ListQuery) {
    const filters: SQL[] = [];
    if (!query.includeInactive) filters.push(eq(suppliers.isActive, true));
    if (query.q) {
      const p = likePattern(query.q);
      filters.push(or(ilike(suppliers.name, p), ilike(suppliers.code, p))!);
    }
    const where = and(...filters);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(suppliers)
        .where(where)
        .orderBy(asc(suppliers.name))
        .limit(query.limit)
        .offset(offsetOf(query)),
      this.db.select({ total: sql<number>`count(*)::int` }).from(suppliers).where(where),
    ]);
    return paginated(rows, total, query);
  }

  async saveSupplier(actor: Principal, input: SupplierInput, id?: string) {
    if (input.isPkp && !input.npwp) {
      throw new BadRequestException('Supplier PKP wajib punya NPWP');
    }
    return this.db.transaction(async (tx) => {
      let before: unknown = null;
      let row;
      if (id) {
        [before] = await tx.select().from(suppliers).where(eq(suppliers.id, id));
        if (!before) throw new NotFoundException('Supplier tidak ditemukan');
        [row] = await tx
          .update(suppliers)
          .set({ ...input, updatedAt: new Date(), updatedBy: actor.userId })
          .where(eq(suppliers.id, id))
          .returning();
      } else {
        [row] = await tx
          .insert(suppliers)
          .values({ ...input, createdBy: actor.userId, updatedBy: actor.userId })
          .returning();
      }
      await this.audit.log(
        {
          action: id ? 'supplier.update' : 'supplier.create',
          entityType: 'supplier',
          entityId: row.id,
          userId: actor.userId,
          before,
          after: row,
        },
        tx,
      );
      return row;
    });
  }

  /** Searches name, phone (any format) or card number — used by the cashier screen. */
  async listMembers(query: ListQuery) {
    const filters: SQL[] = [];
    if (!query.includeInactive) filters.push(eq(members.isActive, true));
    if (query.q) {
      const p = likePattern(query.q);
      const phone = normalizePhone(query.q);
      filters.push(
        or(
          ilike(members.name, p),
          eq(members.cardNo, query.q),
          phone ? eq(members.phone, phone) : ilike(members.phone, p),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(members)
        .where(where)
        .orderBy(asc(members.name))
        .limit(query.limit)
        .offset(offsetOf(query)),
      this.db.select({ total: sql<number>`count(*)::int` }).from(members).where(where),
    ]);
    return paginated(rows, total, query);
  }

  async saveMember(actor: Principal, input: MemberInput, id?: string) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new BadRequestException('Nomor HP tidak valid');
    const values = {
      phone,
      name: input.name,
      cardNo: input.cardNo || null,
      isActive: input.isActive,
    };
    return this.db.transaction(async (tx) => {
      let before: unknown = null;
      let row;
      if (id) {
        [before] = await tx.select().from(members).where(eq(members.id, id));
        if (!before) throw new NotFoundException('Member tidak ditemukan');
        [row] = await tx
          .update(members)
          .set({ ...values, updatedAt: new Date(), updatedBy: actor.userId })
          .where(eq(members.id, id))
          .returning();
      } else {
        [row] = await tx
          .insert(members)
          .values({ ...values, createdBy: actor.userId, updatedBy: actor.userId })
          .returning();
      }
      await this.audit.log(
        {
          action: id ? 'member.update' : 'member.create',
          entityType: 'member',
          entityId: row.id,
          userId: actor.userId,
          before,
          after: row,
        },
        tx,
      );
      return row;
    });
  }
}
