import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import { accounts, locations, paymentMethods, terminals } from '../database/schema/index.js';

type PaymentKind = 'CASH' | 'QRIS' | 'CARD' | 'TRANSFER';

export interface TerminalInput {
  code: string;
  name: string;
  salesLocationId: string;
  defaultFloat: number;
  customerDisplayEnabled: boolean;
  printerConfig?: Record<string, unknown>;
  isActive: boolean;
}

export interface PaymentMethodInput {
  code: string;
  name: string;
  kind: PaymentKind;
  accountId?: string | null;
  requiresReference: boolean;
  sortOrder: number;
  isActive: boolean;
}

/** Which account kind each payment kind settles into (docs/alur/07, kliring QRIS/kartu). */
const ACCOUNT_KIND: Record<PaymentKind, string | null> = { CASH: null, QRIS: 'CLEARING', CARD: 'CLEARING', TRANSFER: 'BANK' };

/** Cash drawers (laci kasir) and payment methods (pengaturan perangkat). */
@Injectable()
export class RegistersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Fresh install: Tunai, QRIS and Kartu; transfer methods need a bank account first. */
  async onApplicationBootstrap() {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('payment-methods-seed'))`);
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(paymentMethods);
      if (count > 0) return;
      const byCode = async (code: string) => (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)))[0]?.id;
      const qris = await byCode('1-1310');
      const card = await byCode('1-1320');
      if (!qris || !card) return; // chart of accounts not installed yet
      await tx.insert(paymentMethods).values([
        { code: 'TUNAI', name: 'Tunai', kind: 'CASH', sortOrder: 1 },
        { code: 'QRIS', name: 'QRIS', kind: 'QRIS', accountId: qris, requiresReference: true, sortOrder: 2 },
        { code: 'KARTU', name: 'Kartu Debit/Kredit', kind: 'CARD', accountId: card, requiresReference: true, sortOrder: 3 },
      ]);
      this.logger.log('Created default payment methods');
    });
  }

  listTerminals() {
    return this.db.select().from(terminals).orderBy(asc(terminals.code));
  }

  /** Each drawer gets its own control account under "Kas Laci Kasir". */
  async createTerminal(actor: Principal, input: TerminalInput) {
    return this.db.transaction(async (tx) => {
      await this.assertSalesLocation(tx, input.salesLocationId);
      const [parent] = await tx.select().from(accounts).where(eq(accounts.code, '1-1120'));
      if (!parent) throw new BadRequestException('Akun induk Kas Laci Kasir (1-1120) tidak ditemukan');
      const [account] = await tx
        .insert(accounts)
        .values({
          code: `1-1120-${input.code.toUpperCase()}`,
          name: `Kas Laci ${input.name}`,
          type: 'ASSET',
          normalBalance: 'DEBIT',
          parentId: parent.id,
          isControl: true,
          cashKind: 'DRAWER',
          isSystem: true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: accounts.id });
      const [row] = await tx
        .insert(terminals)
        .values({ ...input, printerConfig: input.printerConfig ?? {}, cashAccountId: account.id, createdBy: actor.userId, updatedBy: actor.userId })
        .returning();
      await this.audit.log({ action: 'terminal.create', entityType: 'terminal', entityId: row.id, userId: actor.userId, after: row }, tx);
      return row;
    });
  }

  async updateTerminal(actor: Principal, id: string, input: TerminalInput) {
    return this.db.transaction(async (tx) => {
      await this.assertSalesLocation(tx, input.salesLocationId);
      const [row] = await tx
        .update(terminals)
        .set({ name: input.name, salesLocationId: input.salesLocationId, defaultFloat: input.defaultFloat, customerDisplayEnabled: input.customerDisplayEnabled, printerConfig: input.printerConfig ?? {}, isActive: input.isActive, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(terminals.id, id))
        .returning();
      if (!row) throw new NotFoundException('Laci kasir tidak ditemukan');
      await this.audit.log({ action: 'terminal.update', entityType: 'terminal', entityId: id, userId: actor.userId, after: row }, tx);
      return row;
    });
  }

  listPaymentMethods() {
    return this.db.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder));
  }

  async savePaymentMethod(actor: Principal, input: PaymentMethodInput, id?: string) {
    const wanted = ACCOUNT_KIND[input.kind];
    if (wanted === null && input.accountId) throw new BadRequestException('Metode tunai masuk ke kas laci, tanpa akun lain');
    if (wanted) {
      const [account] = input.accountId ? await this.db.select().from(accounts).where(eq(accounts.id, input.accountId)) : [];
      if (!account?.isActive || !account.isPostable || account.cashKind !== wanted) {
        throw new BadRequestException(input.kind === 'TRANSFER' ? 'Pilih akun bank tujuan' : 'Pilih akun kliring (Piutang EDC/QRIS)');
      }
    }
    const values = { ...input, accountId: input.accountId ?? null };
    const [row] = id
      ? await this.db.update(paymentMethods).set({ ...values, updatedAt: new Date(), updatedBy: actor.userId }).where(eq(paymentMethods.id, id)).returning()
      : await this.db.insert(paymentMethods).values({ ...values, createdBy: actor.userId, updatedBy: actor.userId }).returning();
    if (!row) throw new NotFoundException('Metode bayar tidak ditemukan');
    await this.audit.log({ action: id ? 'payment_method.update' : 'payment_method.create', entityType: 'payment_method', entityId: row.id, userId: actor.userId, after: row });
    return row;
  }

  private async assertSalesLocation(tx: DbTransaction, locationId: string) {
    const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
    if (!loc?.isActive || loc.type !== 'DISPLAY') throw new BadRequestException('Lokasi jual harus lokasi display yang aktif');
  }
}
