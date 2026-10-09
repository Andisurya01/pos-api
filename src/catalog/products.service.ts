import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Principal } from '../access/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { likePattern, offsetOf, paginated } from '../common/pagination.js';
import {
  DB,
  type Database,
  type DbExecutor,
  type DbTransaction,
} from '../database/database.module.js';
import {
  barcodes,
  brands,
  bundleComponents,
  categories,
  products,
  skuPrices,
  skus,
  skuUnits,
  suppliers,
  units,
} from '../database/schema/index.js';
import type { PriceRow } from './pricing.js';
import type {
  ComponentInput,
  CreateProductInput,
  PriceInput,
  SkuInput,
  SkuListQuery,
  UnitInput,
  UpdateSkuInput,
} from './products.schemas.js';

const ONE = '1.000';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- products

  async create(actor: Principal, input: CreateProductInput) {
    const productId = await this.db.transaction(async (tx) => {
      await this.assertProductRefs(tx, input.categoryId, input.brandId);
      this.assertUniqueWithinPayload(
        input.skus.map((s) => s.skuCode.toLowerCase()),
        'Kode SKU',
      );
      this.assertUniqueWithinPayload(
        input.skus.flatMap((s) => s.units.flatMap((u) => u.barcodes)),
        'Barcode',
      );
      const [product] = await tx
        .insert(products)
        .values({
          name: input.name,
          categoryId: input.categoryId,
          brandId: input.brandId ?? null,
          description: input.description ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: products.id });
      for (const sku of input.skus) {
        await this.insertSku(tx, actor, product.id, sku);
      }
      await this.audit.log(
        {
          action: 'product.create',
          entityType: 'product',
          entityId: product.id,
          userId: actor.userId,
          after: input,
        },
        tx,
      );
      return product.id;
    });
    return this.detail(productId);
  }

  async updateProduct(
    actor: Principal,
    id: string,
    input: {
      name: string;
      categoryId: string;
      brandId?: string | null;
      description?: string | null;
      isActive: boolean;
    },
  ) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(products).where(eq(products.id, id));
      if (!before) throw new NotFoundException('Produk tidak ditemukan');
      await this.assertProductRefs(tx, input.categoryId, input.brandId);
      const [after] = await tx
        .update(products)
        .set({
          name: input.name,
          categoryId: input.categoryId,
          brandId: input.brandId ?? null,
          description: input.description ?? null,
          isActive: input.isActive,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(products.id, id))
        .returning();
      await this.audit.log(
        {
          action: 'product.update',
          entityType: 'product',
          entityId: id,
          userId: actor.userId,
          before,
          after,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  async addSku(actor: Principal, productId: string, input: SkuInput) {
    await this.db.transaction(async (tx) => {
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId));
      if (!product) throw new NotFoundException('Produk tidak ditemukan');
      this.assertUniqueWithinPayload(input.units.flatMap((u) => u.barcodes), 'Barcode');
      const skuId = await this.insertSku(tx, actor, productId, input);
      await this.audit.log(
        {
          action: 'sku.create',
          entityType: 'sku',
          entityId: skuId,
          userId: actor.userId,
          after: input,
        },
        tx,
      );
    });
    return this.detail(productId);
  }

  // -------------------------------------------------------------------- skus

  async updateSku(actor: Principal, skuId: string, input: UpdateSkuInput) {
    const productId = await this.db.transaction(async (tx) => {
      const before = await this.findSku(tx, skuId);
      if (before.kind === 'BUNDLE' && (input.isPurchasable || input.trackBatch)) {
        throw new BadRequestException('Bundel tidak bisa dibeli atau memakai batch');
      }
      if (input.primarySupplierId) await this.assertSupplier(tx, input.primarySupplierId);
      this.assertAvailability(input.availableFrom, input.availableUntil);
      const [after] = await tx
        .update(skus)
        .set({
          variantName: input.variantName ?? null,
          variantAttrs: input.variantAttrs ?? null,
          isTaxable: input.isTaxable,
          trackBatch: input.trackBatch,
          isSellable: input.isSellable,
          isPurchasable: input.isPurchasable,
          minStock: input.minStock,
          reorderPoint: input.reorderPoint,
          primarySupplierId: input.primarySupplierId ?? null,
          availableFrom: input.availableFrom ?? null,
          availableUntil: input.availableUntil ?? null,
          isActive: input.isActive,
          updatedAt: new Date(),
          updatedBy: actor.userId,
        })
        .where(eq(skus.id, skuId))
        .returning();
      await this.audit.log(
        {
          action: 'sku.update',
          entityType: 'sku',
          entityId: skuId,
          userId: actor.userId,
          before,
          after,
        },
        tx,
      );
      return before.productId;
    });
    return this.detail(productId);
  }

  async addUnit(actor: Principal, skuId: string, input: UnitInput) {
    const productId = await this.db.transaction(async (tx) => {
      const sku = await this.findSku(tx, skuId);
      if (sku.kind === 'BUNDLE') {
        throw new BadRequestException('Bundel hanya punya satu satuan');
      }
      if (input.isBase) {
        throw new BadRequestException('Satuan dasar tidak bisa ditambah atau diganti');
      }
      const unitMap = await this.loadUnits(tx, [input.unitId]);
      this.assertUnitFactor(unitMap.get(input.unitId)!, input.factor);
      this.assertUniqueWithinPayload(input.barcodes, 'Barcode');
      await this.assertBarcodesFree(tx, input.barcodes);
      if (input.isDefaultSale || input.isDefaultPurchase) {
        await tx
          .update(skuUnits)
          .set({
            ...(input.isDefaultSale ? { isDefaultSale: false } : {}),
            ...(input.isDefaultPurchase ? { isDefaultPurchase: false } : {}),
          })
          .where(eq(skuUnits.skuId, skuId));
      }
      const skuUnitId = await this.insertUnit(tx, actor, skuId, input);
      await this.audit.log(
        {
          action: 'sku_unit.create',
          entityType: 'sku_unit',
          entityId: skuUnitId,
          userId: actor.userId,
          after: input,
        },
        tx,
      );
      return sku.productId;
    });
    return this.detail(productId);
  }

  async replaceBarcodes(actor: Principal, skuUnitId: string, codes: string[]) {
    const unique = [...new Set(codes)];
    const productId = await this.db.transaction(async (tx) => {
      const skuUnit = await this.findSkuUnit(tx, skuUnitId);
      const before = await tx
        .select({ barcode: barcodes.barcode })
        .from(barcodes)
        .where(eq(barcodes.skuUnitId, skuUnitId));
      await tx.delete(barcodes).where(eq(barcodes.skuUnitId, skuUnitId));
      await this.assertBarcodesFree(tx, unique);
      if (unique.length > 0) {
        await tx.insert(barcodes).values(unique.map((barcode) => ({ barcode, skuUnitId })));
      }
      await this.audit.log(
        {
          action: 'barcode.replace',
          entityType: 'sku_unit',
          entityId: skuUnitId,
          userId: actor.userId,
          before: before.map((b) => b.barcode),
          after: unique,
        },
        tx,
      );
      return skuUnit.productId;
    });
    return this.detail(productId);
  }

  async setComponents(actor: Principal, skuId: string, components: ComponentInput[]) {
    const productId = await this.db.transaction(async (tx) => {
      const sku = await this.findSku(tx, skuId);
      if (sku.kind !== 'BUNDLE') throw new BadRequestException('SKU ini bukan bundel');
      // TODO(penjualan): refuse once the bundle has been sold (docs/erd/02).
      await this.assertComponents(tx, skuId, components);
      const before = await tx
        .select()
        .from(bundleComponents)
        .where(eq(bundleComponents.bundleSkuId, skuId));
      await tx.delete(bundleComponents).where(eq(bundleComponents.bundleSkuId, skuId));
      await tx
        .insert(bundleComponents)
        .values(components.map((c) => ({ bundleSkuId: skuId, ...c })));
      await this.audit.log(
        {
          action: 'bundle.components',
          entityType: 'sku',
          entityId: skuId,
          userId: actor.userId,
          before,
          after: components,
        },
        tx,
      );
      return sku.productId;
    });
    return this.detail(productId);
  }

  // ------------------------------------------------------------------ prices

  async setPrice(
    actor: Principal,
    skuUnitId: string,
    input: PriceInput & { effectiveFrom?: string },
  ) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const minQty = input.level === 'WHOLESALE' ? (input.minQty ?? ONE) : ONE;
    if (input.level === 'WHOLESALE' && Number(minQty) <= 1) {
      throw new BadRequestException('Harga grosir butuh jumlah minimal lebih dari 1');
    }
    const productId = await this.db.transaction(async (tx) => {
      const skuUnit = await this.findSkuUnit(tx, skuUnitId);
      const current = (await this.currentPrices(tx, [skuUnitId])).get(skuUnitId) ?? [];
      const before = current.find((p) => p.level === input.level && p.minQty === minQty);
      await tx.insert(skuPrices).values({
        skuUnitId,
        level: input.level,
        minQty,
        price: input.price,
        effectiveFrom,
        createdBy: actor.userId,
      });
      await this.audit.log(
        {
          action: 'price.change',
          entityType: 'sku_unit',
          entityId: skuUnitId,
          userId: actor.userId,
          before: before ?? null,
          after: { level: input.level, minQty, price: input.price, effectiveFrom },
        },
        tx,
      );
      return skuUnit.productId;
    });
    return this.detail(productId);
  }

  /** Ends a wholesale tier or member price from a moment on; history is kept. */
  async removeTier(
    actor: Principal,
    skuUnitId: string,
    input: { level: 'WHOLESALE' | 'MEMBER'; minQty?: string; effectiveFrom?: string },
  ) {
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const minQty = input.level === 'WHOLESALE' ? (input.minQty ?? ONE) : ONE;
    const productId = await this.db.transaction(async (tx) => {
      const skuUnit = await this.findSkuUnit(tx, skuUnitId);
      const current = (await this.currentPrices(tx, [skuUnitId])).get(skuUnitId) ?? [];
      const existing = current.find((p) => p.level === input.level && p.minQty === minQty);
      if (!existing) throw new NotFoundException('Tingkat harga ini tidak ada');
      await tx.insert(skuPrices).values({
        skuUnitId,
        level: input.level,
        minQty,
        price: 0,
        isDeleted: true,
        effectiveFrom,
        createdBy: actor.userId,
      });
      await this.audit.log(
        {
          action: 'price.remove_tier',
          entityType: 'sku_unit',
          entityId: skuUnitId,
          userId: actor.userId,
          before: existing,
          after: { level: input.level, minQty, effectiveFrom },
        },
        tx,
      );
      return skuUnit.productId;
    });
    return this.detail(productId);
  }

  async priceHistory(skuId: string) {
    await this.findSku(this.db, skuId);
    return this.db
      .select({
        id: skuPrices.id,
        skuUnitId: skuPrices.skuUnitId,
        unitCode: units.code,
        level: skuPrices.level,
        minQty: skuPrices.minQty,
        price: skuPrices.price,
        isDeleted: skuPrices.isDeleted,
        effectiveFrom: skuPrices.effectiveFrom,
        createdAt: skuPrices.createdAt,
        createdBy: skuPrices.createdBy,
      })
      .from(skuPrices)
      .innerJoin(skuUnits, eq(skuUnits.id, skuPrices.skuUnitId))
      .innerJoin(units, eq(units.id, skuUnits.unitId))
      .where(eq(skuUnits.skuId, skuId))
      .orderBy(desc(skuPrices.effectiveFrom), desc(skuPrices.createdAt));
  }

  /**
   * Prices in effect at `at`, per sku unit: the latest row per (level, min_qty),
   * minus tiers that were removed.
   */
  async currentPrices(executor: DbExecutor, skuUnitIds: string[], at = new Date()) {
    const result = new Map<string, PriceRow[]>();
    if (skuUnitIds.length === 0) return result;
    const rows = await executor
      .selectDistinctOn([skuPrices.skuUnitId, skuPrices.level, skuPrices.minQty], {
        skuUnitId: skuPrices.skuUnitId,
        level: skuPrices.level,
        minQty: skuPrices.minQty,
        price: skuPrices.price,
        isDeleted: skuPrices.isDeleted,
      })
      .from(skuPrices)
      .where(and(inArray(skuPrices.skuUnitId, skuUnitIds), lte(skuPrices.effectiveFrom, at)))
      .orderBy(
        skuPrices.skuUnitId,
        skuPrices.level,
        skuPrices.minQty,
        desc(skuPrices.effectiveFrom),
        desc(skuPrices.createdAt),
      );
    for (const row of rows) {
      if (row.isDeleted) continue;
      const list = result.get(row.skuUnitId) ?? [];
      list.push({ level: row.level, minQty: row.minQty, price: row.price });
      result.set(row.skuUnitId, list);
    }
    return result;
  }

  // ------------------------------------------------------------------- reads

  async detail(productId: string, executor: DbExecutor = this.db) {
    const [product] = await executor
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        isActive: products.isActive,
        category: { id: categories.id, name: categories.name },
        brandId: products.brandId,
        brandName: brands.name,
      })
      .from(products)
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(eq(products.id, productId));
    if (!product) throw new NotFoundException('Produk tidak ditemukan');

    const skuRows = await executor
      .select()
      .from(skus)
      .where(eq(skus.productId, productId))
      .orderBy(asc(skus.skuCode));
    const skuIds = skuRows.map((s) => s.id);
    const unitRows = skuIds.length
      ? await executor
          .select({
            id: skuUnits.id,
            skuId: skuUnits.skuId,
            factor: skuUnits.factor,
            isBase: skuUnits.isBase,
            isDefaultSale: skuUnits.isDefaultSale,
            isDefaultPurchase: skuUnits.isDefaultPurchase,
            unit: { id: units.id, code: units.code, name: units.name },
          })
          .from(skuUnits)
          .innerJoin(units, eq(units.id, skuUnits.unitId))
          .where(inArray(skuUnits.skuId, skuIds))
          .orderBy(asc(skuUnits.factor))
      : [];
    const unitIds = unitRows.map((u) => u.id);
    const barcodeRows = unitIds.length
      ? await executor.select().from(barcodes).where(inArray(barcodes.skuUnitId, unitIds))
      : [];
    const prices = await this.currentPrices(executor, unitIds);
    const componentRows = skuIds.length
      ? await executor
          .select({
            bundleSkuId: bundleComponents.bundleSkuId,
            componentSkuId: bundleComponents.componentSkuId,
            qty: bundleComponents.qty,
            skuCode: skus.skuCode,
            productName: products.name,
            variantName: skus.variantName,
          })
          .from(bundleComponents)
          .innerJoin(skus, eq(skus.id, bundleComponents.componentSkuId))
          .innerJoin(products, eq(products.id, skus.productId))
          .where(inArray(bundleComponents.bundleSkuId, skuIds))
      : [];

    const { brandId, brandName, ...rest } = product;
    return {
      ...rest,
      brand: brandId ? { id: brandId, name: brandName } : null,
      skus: skuRows.map((sku) => ({
        ...sku,
        displayName: displayName(product.name, sku.variantName),
        units: unitRows
          .filter((u) => u.skuId === sku.id)
          .map(({ skuId: _skuId, ...u }) => ({
            ...u,
            barcodes: barcodeRows.filter((b) => b.skuUnitId === u.id).map((b) => b.barcode),
            prices: prices.get(u.id) ?? [],
          })),
        components: componentRows
          .filter((c) => c.bundleSkuId === sku.id)
          .map((c) => ({
            componentSkuId: c.componentSkuId,
            skuCode: c.skuCode,
            displayName: displayName(c.productName, c.variantName),
            qty: c.qty,
          })),
      })),
    };
  }

  /** Flat SKU list for the back office: one row per sellable item. */
  async listSkus(query: SkuListQuery) {
    const filters: SQL[] = [];
    if (!query.includeInactive) {
      filters.push(eq(skus.isActive, true), eq(products.isActive, true));
    }
    if (query.categoryId) filters.push(eq(products.categoryId, query.categoryId));
    if (query.q) {
      const p = likePattern(query.q);
      filters.push(
        or(
          ilike(products.name, p),
          ilike(skus.skuCode, p),
          ilike(skus.variantName, p),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(barcodes)
              .innerJoin(skuUnits, eq(skuUnits.id, barcodes.skuUnitId))
              .where(and(eq(skuUnits.skuId, skus.id), eq(barcodes.barcode, query.q))),
          ),
        )!,
      );
    }
    const where = and(...filters);
    const base = this.db
      .select({
        skuId: skus.id,
        productId: products.id,
        productName: products.name,
        variantName: skus.variantName,
        skuCode: skus.skuCode,
        kind: skus.kind,
        isWeighed: skus.isWeighed,
        isActive: sql<boolean>`${skus.isActive} and ${products.isActive}`,
        categoryName: categories.name,
        brandName: brands.name,
      })
      .from(skus)
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(where);
    const [rows, [{ total }]] = await Promise.all([
      base.orderBy(asc(products.name), asc(skus.skuCode)).limit(query.limit).offset(offsetOf(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(skus)
        .innerJoin(products, eq(products.id, skus.productId))
        .where(where),
    ]);

    const saleUnits = rows.length
      ? await this.db
          .select({ id: skuUnits.id, skuId: skuUnits.skuId, unitCode: units.code })
          .from(skuUnits)
          .innerJoin(units, eq(units.id, skuUnits.unitId))
          .where(and(inArray(skuUnits.skuId, rows.map((r) => r.skuId)), eq(skuUnits.isDefaultSale, true)))
      : [];
    const prices = await this.currentPrices(this.db, saleUnits.map((u) => u.id));
    const data = rows.map(({ productName, variantName, ...r }) => {
      const saleUnit = saleUnits.find((u) => u.skuId === r.skuId);
      const retail = saleUnit
        ? prices.get(saleUnit.id)?.find((p) => p.level === 'RETAIL')
        : undefined;
      return {
        ...r,
        displayName: displayName(productName, variantName),
        saleUnit: saleUnit ? { skuUnitId: saleUnit.id, code: saleUnit.unitCode } : null,
        retailPrice: retail?.price ?? null,
      };
    });
    return paginated(data, total, query);
  }

  /** Barcode first, then SKU code (default sale unit). Used by the cashier and receiving. */
  async lookup(code: string) {
    const trimmed = code.trim();
    const [byBarcode] = await this.db
      .select({ skuUnitId: barcodes.skuUnitId })
      .from(barcodes)
      .where(eq(barcodes.barcode, trimmed));
    let skuUnitId = byBarcode?.skuUnitId;
    if (!skuUnitId) {
      const [bySku] = await this.db
        .select({ skuUnitId: skuUnits.id })
        .from(skus)
        .innerJoin(skuUnits, and(eq(skuUnits.skuId, skus.id), eq(skuUnits.isDefaultSale, true)))
        .where(sql`lower(${skus.skuCode}) = lower(${trimmed})`);
      skuUnitId = bySku?.skuUnitId;
    }
    if (!skuUnitId) throw new NotFoundException('Barang dengan kode ini tidak ditemukan');

    const [row] = await this.db
      .select({
        skuId: skus.id,
        productId: products.id,
        productName: products.name,
        variantName: skus.variantName,
        skuCode: skus.skuCode,
        kind: skus.kind,
        isWeighed: skus.isWeighed,
        isTaxable: skus.isTaxable,
        trackBatch: skus.trackBatch,
        isSellable: skus.isSellable,
        isActive: sql<boolean>`${skus.isActive} and ${products.isActive}`,
        categoryId: products.categoryId,
        brandId: products.brandId,
        skuUnitId: skuUnits.id,
        factor: skuUnits.factor,
        unit: { id: units.id, code: units.code, name: units.name },
      })
      .from(skuUnits)
      .innerJoin(skus, eq(skus.id, skuUnits.skuId))
      .innerJoin(products, eq(products.id, skus.productId))
      .innerJoin(units, eq(units.id, skuUnits.unitId))
      .where(eq(skuUnits.id, skuUnitId));
    const prices = await this.currentPrices(this.db, [skuUnitId]);
    const { productName, variantName, ...rest } = row;
    return {
      ...rest,
      displayName: displayName(productName, variantName),
      prices: prices.get(skuUnitId) ?? [],
    };
  }

  // ----------------------------------------------------------------- helpers

  private async insertSku(
    tx: DbTransaction,
    actor: Principal,
    productId: string,
    sku: SkuInput,
  ) {
    const unitIds = sku.units.map((u) => u.unitId);
    this.assertUniqueWithinPayload(unitIds, 'Satuan');
    const bases = sku.units.filter((u) => u.isBase);
    if (bases.length !== 1) {
      throw new BadRequestException(`SKU ${sku.skuCode}: harus ada tepat satu satuan dasar`);
    }
    const unitMap = await this.loadUnits(tx, unitIds);
    const base = bases[0];
    if (base.factor !== ONE) {
      throw new BadRequestException(`SKU ${sku.skuCode}: faktor satuan dasar harus 1`);
    }
    if (sku.isWeighed && !unitMap.get(base.unitId)!.allowsDecimal) {
      throw new BadRequestException(
        `SKU ${sku.skuCode}: barang timbang butuh satuan dasar yang boleh desimal (contoh kg)`,
      );
    }
    for (const u of sku.units) this.assertUnitFactor(unitMap.get(u.unitId)!, u.factor);

    if (sku.kind === 'BUNDLE') {
      if (sku.units.length !== 1) {
        throw new BadRequestException(`Bundel ${sku.skuCode} hanya boleh punya satu satuan`);
      }
      if (sku.isPurchasable || sku.trackBatch || sku.isWeighed) {
        throw new BadRequestException(
          `Bundel ${sku.skuCode} tidak bisa dibeli, memakai batch, atau ditimbang`,
        );
      }
      if (sku.components.length === 0) {
        throw new BadRequestException(`Bundel ${sku.skuCode} minimal punya satu komponen`);
      }
    } else if (sku.components.length > 0) {
      throw new BadRequestException(`SKU ${sku.skuCode} bukan bundel, tidak boleh punya komponen`);
    }

    // Default units: explicit flags win; otherwise the base unit.
    for (const flag of ['isDefaultSale', 'isDefaultPurchase'] as const) {
      const flagged = sku.units.filter((u) => u[flag]).length;
      if (flagged > 1) {
        throw new BadRequestException(`SKU ${sku.skuCode}: hanya satu satuan default`);
      }
      if (flagged === 0) base[flag] = true;
    }
    const saleUnit = sku.units.find((u) => u.isDefaultSale)!;
    if (sku.isSellable && !saleUnit.prices.some((p) => p.level === 'RETAIL')) {
      throw new BadRequestException(
        `SKU ${sku.skuCode}: satuan jual default wajib punya harga eceran`,
      );
    }
    if (sku.primarySupplierId) await this.assertSupplier(tx, sku.primarySupplierId);
    this.assertAvailability(sku.availableFrom, sku.availableUntil);
    await this.assertBarcodesFree(tx, sku.units.flatMap((u) => u.barcodes));

    const [row] = await tx
      .insert(skus)
      .values({
        productId,
        skuCode: sku.skuCode,
        variantName: sku.variantName ?? null,
        variantAttrs: sku.variantAttrs ?? null,
        kind: sku.kind,
        baseUnitId: base.unitId,
        isWeighed: sku.isWeighed,
        isTaxable: sku.isTaxable,
        trackBatch: sku.trackBatch,
        isSellable: sku.isSellable,
        isPurchasable: sku.isPurchasable,
        minStock: sku.minStock,
        reorderPoint: sku.reorderPoint,
        primarySupplierId: sku.primarySupplierId ?? null,
        availableFrom: sku.availableFrom ?? null,
        availableUntil: sku.availableUntil ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: skus.id });
    for (const unit of sku.units) await this.insertUnit(tx, actor, row.id, unit);
    if (sku.kind === 'BUNDLE') {
      await this.assertComponents(tx, row.id, sku.components);
      await tx
        .insert(bundleComponents)
        .values(sku.components.map((c) => ({ bundleSkuId: row.id, ...c })));
    }
    return row.id;
  }

  private async insertUnit(
    tx: DbTransaction,
    actor: Principal,
    skuId: string,
    unit: UnitInput,
  ) {
    const [row] = await tx
      .insert(skuUnits)
      .values({
        skuId,
        unitId: unit.unitId,
        factor: unit.factor,
        isBase: unit.isBase,
        isDefaultSale: unit.isDefaultSale,
        isDefaultPurchase: unit.isDefaultPurchase,
      })
      .returning({ id: skuUnits.id });
    if (unit.barcodes.length > 0) {
      await tx
        .insert(barcodes)
        .values([...new Set(unit.barcodes)].map((barcode) => ({ barcode, skuUnitId: row.id })));
    }
    const prices = unit.prices.map((p) => ({
      level: p.level,
      minQty: p.level === 'WHOLESALE' ? (p.minQty ?? ONE) : ONE,
      price: p.price,
    }));
    this.assertUniqueWithinPayload(
      prices.map((p) => `${p.level}@${p.minQty}`),
      'Tingkat harga',
    );
    if (prices.some((p) => p.level === 'WHOLESALE' && Number(p.minQty) <= 1)) {
      throw new BadRequestException('Harga grosir butuh jumlah minimal lebih dari 1');
    }
    if (prices.length > 0) {
      await tx.insert(skuPrices).values(
        prices.map((p) => ({ ...p, skuUnitId: row.id, createdBy: actor.userId })),
      );
    }
    return row.id;
  }

  private async loadUnits(tx: DbExecutor, unitIds: string[]) {
    const rows = await tx.select().from(units).where(inArray(units.id, unitIds));
    if (rows.length !== new Set(unitIds).size) {
      throw new BadRequestException('Ada satuan yang tidak ditemukan');
    }
    return new Map(rows.map((r) => [r.id, r]));
  }

  private assertUnitFactor(unit: { code: string }, factor: string) {
    if (Number(factor) <= 0) {
      throw new BadRequestException(`Faktor satuan ${unit.code} harus lebih dari 0`);
    }
  }

  private async assertComponents(tx: DbTransaction, bundleSkuId: string, components: ComponentInput[]) {
    const ids = components.map((c) => c.componentSkuId);
    this.assertUniqueWithinPayload(ids, 'Komponen');
    if (ids.includes(bundleSkuId)) {
      throw new BadRequestException('Bundel tidak boleh berisi dirinya sendiri');
    }
    const rows = await tx
      .select({ id: skus.id, kind: skus.kind })
      .from(skus)
      .where(inArray(skus.id, ids));
    if (rows.length !== ids.length) {
      throw new BadRequestException('Ada komponen bundel yang tidak ditemukan');
    }
    if (rows.some((r) => r.kind !== 'STANDARD')) {
      throw new BadRequestException('Komponen bundel harus barang biasa, bukan bundel');
    }
  }

  private async assertBarcodesFree(tx: DbExecutor, codes: string[]) {
    if (codes.length === 0) return;
    const taken = await tx
      .select({ barcode: barcodes.barcode })
      .from(barcodes)
      .where(inArray(barcodes.barcode, [...new Set(codes)]));
    if (taken.length > 0) {
      throw new ConflictException({
        message: 'Barcode sudah dipakai produk lain',
        barcodes: taken.map((t) => t.barcode),
      });
    }
  }

  private assertUniqueWithinPayload(values: string[], label: string) {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) throw new BadRequestException(`${label} "${v}" diisi lebih dari sekali`);
      seen.add(v);
    }
  }

  private assertAvailability(from?: string | null, until?: string | null) {
    if (from && until && until < from) {
      throw new BadRequestException('Tanggal akhir periode jual sebelum tanggal mulai');
    }
  }

  private async assertProductRefs(tx: DbExecutor, categoryId: string, brandId?: string | null) {
    const [category] = await tx
      .select({ isActive: categories.isActive })
      .from(categories)
      .where(eq(categories.id, categoryId));
    if (!category?.isActive) throw new BadRequestException('Kategori tidak ditemukan atau nonaktif');
    if (brandId) {
      const [brand] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, brandId));
      if (!brand) throw new BadRequestException('Merek tidak ditemukan');
    }
  }

  private async assertSupplier(tx: DbExecutor, supplierId: string) {
    const [row] = await tx
      .select({ isActive: suppliers.isActive })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId));
    if (!row?.isActive) throw new BadRequestException('Supplier tidak ditemukan atau nonaktif');
  }

  private async findSku(tx: DbExecutor, skuId: string) {
    const [sku] = await tx.select().from(skus).where(eq(skus.id, skuId));
    if (!sku) throw new NotFoundException('SKU tidak ditemukan');
    return sku;
  }

  private async findSkuUnit(tx: DbExecutor, skuUnitId: string) {
    const [row] = await tx
      .select({ id: skuUnits.id, skuId: skuUnits.skuId, productId: skus.productId })
      .from(skuUnits)
      .innerJoin(skus, eq(skus.id, skuUnits.skuId))
      .where(eq(skuUnits.id, skuUnitId));
    if (!row) throw new NotFoundException('Satuan SKU tidak ditemukan');
    return row;
  }

  /** Price changes may be scheduled ahead, never backdated (history must stay true). */
  private effectiveFrom(value?: string) {
    if (!value) return new Date();
    const at = new Date(value);
    if (at.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Tanggal berlaku harga tidak boleh di masa lalu');
    }
    return at;
  }
}

export function displayName(productName: string, variantName: string | null) {
  return variantName ? `${productName} ${variantName}` : productName;
}
