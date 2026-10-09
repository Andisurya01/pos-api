import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { moneySchema } from '../common/quantity.js';
import { DB, type Database, type DbTransaction } from '../database/database.module.js';
import {
  brands,
  categories,
  promotions,
  promotionTargets,
  skus,
} from '../database/schema/index.js';

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:mm');

export const promotionSchema = z
  .object({
    name: z.string().trim().min(1, 'Nama promo wajib diisi').max(100),
    type: z.enum(['ITEM_DISCOUNT', 'TOTAL_DISCOUNT']),
    discountKind: z.enum(['PERCENT', 'AMOUNT']),
    discountValue: z.number().positive(),
    maxDiscount: moneySchema.nullish(),
    minPurchase: moneySchema.nullish(),
    memberOnly: z.boolean().default(false),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).nullish(),
    timeStart: timeSchema.nullish(),
    timeEnd: timeSchema.nullish(),
    isActive: z.boolean().default(true),
    targets: z
      .array(
        z.object({
          targetType: z.enum(['SKU', 'CATEGORY', 'BRAND']),
          targetId: z.uuid(),
        }),
      )
      .default([]),
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (p.discountKind === 'PERCENT' && p.discountValue > 100) {
      issue('discountValue', 'Persentase maksimal 100');
    }
    if (p.discountKind === 'AMOUNT' && !Number.isInteger(p.discountValue)) {
      issue('discountValue', 'Potongan rupiah harus bilangan bulat');
    }
    if (new Date(p.endsAt) <= new Date(p.startsAt)) {
      issue('endsAt', 'Tanggal selesai harus setelah tanggal mulai');
    }
    if (Boolean(p.timeStart) !== Boolean(p.timeEnd)) {
      issue('timeEnd', 'Jam mulai dan jam selesai diisi berpasangan');
    } else if (p.timeStart && p.timeEnd && p.timeEnd <= p.timeStart) {
      issue('timeEnd', 'Jam selesai harus setelah jam mulai');
    }
    if (p.type === 'ITEM_DISCOUNT') {
      if (p.targets.length === 0) issue('targets', 'Diskon item butuh minimal satu sasaran');
      if (p.minPurchase) issue('minPurchase', 'Minimal belanja hanya untuk diskon total');
    } else if (p.targets.length > 0) {
      issue('targets', 'Diskon total berlaku untuk seluruh transaksi, tanpa sasaran');
    }
  });

export type PromotionInput = z.infer<typeof promotionSchema>;

/**
 * Promo definitions (docs/alur/03). Which promo applies to a cart — and the rule that
 * item and total discounts never stack — is decided by the sales module at checkout.
 */
@Injectable()
export class PromotionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(activeOnly: boolean) {
    const now = new Date();
    return this.db
      .select()
      .from(promotions)
      .where(
        activeOnly
          ? and(
              eq(promotions.isActive, true),
              lte(promotions.startsAt, now),
              gt(promotions.endsAt, now),
            )
          : undefined,
      )
      .orderBy(desc(promotions.startsAt));
  }

  async detail(id: string) {
    const [promo] = await this.db.select().from(promotions).where(eq(promotions.id, id));
    if (!promo) throw new NotFoundException('Promo tidak ditemukan');
    const targets = await this.db
      .select({ targetType: promotionTargets.targetType, targetId: promotionTargets.targetId })
      .from(promotionTargets)
      .where(eq(promotionTargets.promotionId, id));
    return { ...promo, targets };
  }

  async save(actor: Principal, input: PromotionInput, id?: string) {
    const promoId = await this.db.transaction(async (tx) => {
      await this.assertTargets(tx, input.targets);
      const values = {
        name: input.name,
        type: input.type,
        discountKind: input.discountKind,
        discountValue: String(input.discountValue),
        maxDiscount: input.maxDiscount ?? null,
        minPurchase: input.minPurchase ?? null,
        memberOnly: input.memberOnly,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        daysOfWeek: input.daysOfWeek?.length ? [...new Set(input.daysOfWeek)].sort((a, b) => a - b) : null,
        timeStart: input.timeStart ?? null,
        timeEnd: input.timeEnd ?? null,
        isActive: input.isActive,
      };
      let before: unknown = null;
      let rowId: string;
      if (id) {
        before = await this.detail(id);
        await tx
          .update(promotions)
          .set({ ...values, updatedAt: new Date(), updatedBy: actor.userId })
          .where(eq(promotions.id, id));
        await tx.delete(promotionTargets).where(eq(promotionTargets.promotionId, id));
        rowId = id;
      } else {
        const [row] = await tx
          .insert(promotions)
          .values({ ...values, createdBy: actor.userId, updatedBy: actor.userId })
          .returning({ id: promotions.id });
        rowId = row.id;
      }
      if (input.targets.length > 0) {
        await tx
          .insert(promotionTargets)
          .values(input.targets.map((t) => ({ ...t, promotionId: rowId })));
      }
      await this.audit.log(
        {
          action: id ? 'promotion.update' : 'promotion.create',
          entityType: 'promotion',
          entityId: rowId,
          userId: actor.userId,
          before,
          after: input,
        },
        tx,
      );
      return rowId;
    });
    return this.detail(promoId);
  }

  private async assertTargets(tx: DbTransaction, targets: PromotionInput['targets']) {
    const tables = { SKU: skus, CATEGORY: categories, BRAND: brands } as const;
    for (const type of ['SKU', 'CATEGORY', 'BRAND'] as const) {
      const ids = [...new Set(targets.filter((t) => t.targetType === type).map((t) => t.targetId))];
      if (ids.length === 0) continue;
      const table = tables[type];
      const found = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
      if (found.length !== ids.length) {
        throw new BadRequestException('Ada sasaran promo yang tidak ditemukan');
      }
    }
  }
}
