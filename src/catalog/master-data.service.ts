import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { DB, type Database } from '../database/database.module.js';
import { brands, categories, units } from '../database/schema/index.js';

const DEFAULT_UNITS = [
  { code: 'pcs', name: 'Pcs', allowsDecimal: false },
  { code: 'pack', name: 'Pack', allowsDecimal: false },
  { code: 'renceng', name: 'Renceng', allowsDecimal: false },
  { code: 'dus', name: 'Dus', allowsDecimal: false },
  { code: 'karton', name: 'Karton', allowsDecimal: false },
  { code: 'kg', name: 'Kilogram', allowsDecimal: true },
  { code: 'liter', name: 'Liter', allowsDecimal: true },
];

/** Categories, brands and units (izin `produk.kategori.ubah`). */
@Injectable()
export class MasterDataService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MasterDataService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Fresh install: common minimarket units so products can be entered right away. */
  async onApplicationBootstrap() {
    const inserted = await this.db
      .insert(units)
      .values(DEFAULT_UNITS)
      .onConflictDoNothing()
      .returning({ id: units.id });
    if (inserted.length > 0) {
      this.logger.log(`Created ${inserted.length} default units`);
    }
  }

  listCategories(includeInactive: boolean) {
    return this.db
      .select()
      .from(categories)
      .where(includeInactive ? undefined : eq(categories.isActive, true))
      .orderBy(asc(categories.name));
  }

  async createCategory(
    actor: Principal,
    input: { name: string; parentId?: string | null },
  ) {
    if (input.parentId) await this.findCategory(input.parentId);
    const [row] = await this.db
      .insert(categories)
      .values({
        name: input.name,
        parentId: input.parentId ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();
    await this.audit.log({
      action: 'category.create',
      entityType: 'category',
      entityId: row.id,
      userId: actor.userId,
      after: row,
    });
    return row;
  }

  async updateCategory(
    actor: Principal,
    id: string,
    input: { name: string; parentId?: string | null; isActive: boolean },
  ) {
    const before = await this.findCategory(id);
    if (input.parentId) {
      await this.assertNotDescendant(id, input.parentId);
    }
    const [row] = await this.db
      .update(categories)
      .set({
        name: input.name,
        parentId: input.parentId ?? null,
        isActive: input.isActive,
        updatedAt: new Date(),
        updatedBy: actor.userId,
      })
      .where(eq(categories.id, id))
      .returning();
    await this.audit.log({
      action: 'category.update',
      entityType: 'category',
      entityId: id,
      userId: actor.userId,
      before,
      after: row,
    });
    return row;
  }

  listBrands() {
    return this.db.select().from(brands).orderBy(asc(brands.name));
  }

  async saveBrand(actor: Principal, input: { name: string }, id?: string) {
    if (id) {
      const [row] = await this.db
        .update(brands)
        .set({ name: input.name, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(brands.id, id))
        .returning();
      if (!row) throw new NotFoundException('Merek tidak ditemukan');
      return row;
    }
    const [row] = await this.db
      .insert(brands)
      .values({ name: input.name, createdBy: actor.userId, updatedBy: actor.userId })
      .returning();
    return row;
  }

  listUnits() {
    return this.db.select().from(units).orderBy(asc(units.name));
  }

  async saveUnit(
    actor: Principal,
    input: { code: string; name: string; allowsDecimal: boolean },
    id?: string,
  ) {
    if (id) {
      const [row] = await this.db
        .update(units)
        .set({ ...input, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(units.id, id))
        .returning();
      if (!row) throw new NotFoundException('Satuan tidak ditemukan');
      return row;
    }
    const [row] = await this.db
      .insert(units)
      .values({ ...input, createdBy: actor.userId, updatedBy: actor.userId })
      .returning();
    return row;
  }

  private async findCategory(id: string) {
    const [row] = await this.db.select().from(categories).where(eq(categories.id, id));
    if (!row) throw new NotFoundException('Kategori tidak ditemukan');
    return row;
  }

  /** A category cannot be moved under itself or one of its own children. */
  private async assertNotDescendant(id: string, newParentId: string) {
    const rows = await this.db.execute<{ id: string }>(sql`
      with recursive tree as (
        select id from categories where id = ${id}
        union all
        select c.id from categories c join tree t on c.parent_id = t.id
      )
      select id from tree where id = ${newParentId}
    `);
    if (rows.rows.length > 0) {
      throw new BadRequestException('Kategori tidak bisa menjadi induk dirinya sendiri');
    }
  }
}
