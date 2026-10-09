import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Catalog: products, prices, promos, members, suppliers (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  let owner: { Authorization: string };
  let kasir: { Authorization: string };
  const unit: Record<string, string> = {};
  let categoryId: string;
  let brandId: string;

  const login = async (username: string, password: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };

  const indomie = () => ({
    name: 'Indomie',
    categoryId,
    brandId,
    skus: [
      {
        skuCode: 'IDM-GRG',
        variantName: 'Goreng',
        units: [
          {
            unitId: unit.pcs,
            factor: 1,
            isBase: true,
            barcodes: ['089686010947'],
            prices: [
              { level: 'RETAIL', price: 3500 },
              { level: 'MEMBER', price: 3400 },
              { level: 'WHOLESALE', minQty: 10, price: 3300 },
            ],
          },
          {
            unitId: unit.dus,
            factor: 40,
            barcodes: ['189686010944'],
            prices: [{ level: 'RETAIL', price: 128000 }],
          },
        ],
      },
      {
        skuCode: 'IDM-SOTO',
        variantName: 'Soto',
        units: [
          {
            unitId: unit.pcs,
            factor: '1',
            isBase: true,
            barcodes: ['089686010015'],
            prices: [{ level: 'RETAIL', price: 3400 }],
          },
        ],
      },
    ],
  });

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    await http()
      .post('/api/v1/setup/owner')
      .send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' })
      .expect(201);
    owner = await login('owner', 'owner-pass-123');
    const [kasirUser] = await testQuery<{ id: string }>(
      `insert into users (username, full_name, password_hash) values ('kasir', 'Kasir', $1) returning id`,
      [await hash('kasir-pass-1')],
    );
    await testQuery(
      `insert into user_roles (user_id, role_id) select $1, id from roles where name = 'Kasir'`,
      [kasirUser.id],
    );
    kasir = await login('kasir', 'kasir-pass-1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('seeds common units on a fresh install', async () => {
    const res = await http().get('/api/v1/units').set(owner).expect(200);
    for (const u of res.body) unit[u.code] = u.id;
    expect(Object.keys(unit)).toEqual(
      expect.arrayContaining(['pcs', 'pack', 'renceng', 'dus', 'karton', 'kg', 'liter']),
    );
    expect(res.body.find((u: { code: string }) => u.code === 'kg').allowsDecimal).toBe(true);
  });

  it('creates categories and brands, rejecting duplicate names with a clear 409', async () => {
    const cat = await http()
      .post('/api/v1/categories')
      .set(owner)
      .send({ name: 'Mi Instan' })
      .expect(201);
    categoryId = cat.body.id;
    const dup = await http()
      .post('/api/v1/categories')
      .set(owner)
      .send({ name: 'mi instan' })
      .expect(409);
    expect(dup.body.message).toBe('Nama kategori sudah ada');
    const brand = await http().post('/api/v1/brands').set(owner).send({ name: 'Indofood' }).expect(201);
    brandId = brand.body.id;
    await http()
      .put(`/api/v1/categories/${categoryId}`)
      .set(owner)
      .send({ name: 'Mi Instan', parentId: categoryId })
      .expect(400);
  });

  describe('suppliers and members', () => {
    it('requires an NPWP for PKP suppliers and searches by name or code', async () => {
      await http()
        .post('/api/v1/suppliers')
        .set(owner)
        .send({ code: 'SUP-01', name: 'PT Indomarco', isPkp: true })
        .expect(400);
      await http()
        .post('/api/v1/suppliers')
        .set(owner)
        .send({ code: 'SUP-01', name: 'PT Indomarco', isPkp: true, npwp: '01.234.567.8-901.000', leadTimeDays: 2 })
        .expect(201);
      const res = await http().get('/api/v1/suppliers?q=sup-01').set(owner).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toMatchObject({ total: 1, page: 1 });
    });

    it('normalizes member phone numbers so any format finds the same member', async () => {
      const created = await http()
        .post('/api/v1/members')
        .set(kasir)
        .send({ phone: '0812-3456-7890', name: 'Bu Sari' })
        .expect(201);
      expect(created.body.phone).toBe('6281234567890');
      await http()
        .post('/api/v1/members')
        .set(kasir)
        .send({ phone: '+62 812 3456 7890', name: 'Sari lagi' })
        .expect(409);
      const found = await http().get('/api/v1/members?q=081234567890').set(kasir).expect(200);
      expect(found.body.data.map((m: { name: string }) => m.name)).toEqual(['Bu Sari']);
      await http()
        .post('/api/v1/members')
        .set(kasir)
        .send({ phone: '021-555-1234', name: 'Telepon rumah' })
        .expect(400);
    });
  });

  describe('products', () => {
    let goreng: { skuId: string; pcsUnitId: string; dusUnitId: string; productId: string };

    it('creates a product with variants, units, barcodes and tiered prices', async () => {
      const res = await http().post('/api/v1/products').set(owner).send(indomie()).expect(201);
      expect(res.body.skus.map((s: { displayName: string }) => s.displayName)).toEqual([
        'Indomie Goreng',
        'Indomie Soto',
      ]);
      const sku = res.body.skus[0];
      const pcs = sku.units.find((u: { unit: { code: string } }) => u.unit.code === 'pcs');
      const dus = sku.units.find((u: { unit: { code: string } }) => u.unit.code === 'dus');
      expect(pcs).toMatchObject({ factor: '1.000', isBase: true, isDefaultSale: true, isDefaultPurchase: true });
      expect(dus).toMatchObject({ factor: '40.000', isBase: false, barcodes: ['189686010944'] });
      expect(pcs.prices).toEqual(
        expect.arrayContaining([
          { level: 'RETAIL', minQty: '1.000', price: 3500 },
          { level: 'MEMBER', minQty: '1.000', price: 3400 },
          { level: 'WHOLESALE', minQty: '10.000', price: 3300 },
        ]),
      );
      goreng = { skuId: sku.id, pcsUnitId: pcs.id, dusUnitId: dus.id, productId: res.body.id };
    });

    it('rejects a barcode that another product already uses, naming it', async () => {
      const copy = indomie();
      copy.name = 'Indomie Palsu';
      copy.skus = [{ ...copy.skus[1], skuCode: 'PALSU-1' }];
      const res = await http().post('/api/v1/products').set(owner).send(copy).expect(409);
      expect(res.body.barcodes).toEqual(['089686010015']);
    });

    it.each([
      [
        'two base units',
        { units: [
          { unitId: 'pcs', factor: 1, isBase: true, prices: [{ level: 'RETAIL', price: 1000 }] },
          { unitId: 'dus', factor: 1, isBase: true },
        ] },
        'tepat satu satuan dasar',
      ],
      [
        'no retail price',
        { units: [{ unitId: 'pcs', factor: 1, isBase: true, prices: [{ level: 'MEMBER', price: 900 }] }] },
        'harga eceran',
      ],
      [
        'weighed goods on a pcs base unit',
        { isWeighed: true, units: [{ unitId: 'pcs', factor: 1, isBase: true, prices: [{ level: 'RETAIL', price: 1000 }] }] },
        'boleh desimal',
      ],
    ])('rejects %s', async (_label, skuPatch, message) => {
      const patch = skuPatch as { units: Array<{ unitId: string }> };
      const res = await http()
        .post('/api/v1/products')
        .set(owner)
        .send({
          name: 'Salah',
          categoryId,
          skus: [{ skuCode: `BAD-${Math.random()}`, ...patch, units: patch.units.map((u) => ({ ...u, unitId: unit[u.unitId] })) }],
        })
        .expect(400);
      expect(res.body.message).toContain(message);
    });

    it('stores weighed goods in kg with gram precision', async () => {
      const res = await http()
        .post('/api/v1/products')
        .set(owner)
        .send({
          name: 'Beras Curah',
          categoryId,
          skus: [{
            skuCode: 'BRS-CRH',
            isWeighed: true,
            isTaxable: false,
            units: [{ unitId: unit.kg, factor: 1, isBase: true, prices: [{ level: 'RETAIL', price: 14500 }] }],
          }],
        })
        .expect(201);
      expect(res.body.skus[0]).toMatchObject({ isWeighed: true, isTaxable: false, minStock: '0.000' });
    });

    it('finds items by barcode (unit-specific), SKU code or name', async () => {
      const dus = await http().get('/api/v1/catalog/lookup?code=189686010944').set(kasir).expect(200);
      expect(dus.body).toMatchObject({
        displayName: 'Indomie Goreng',
        factor: '40.000',
        unit: { code: 'dus' },
        prices: [{ level: 'RETAIL', price: 128000 }],
      });
      const bySku = await http().get('/api/v1/catalog/lookup?code=idm-soto').set(kasir).expect(200);
      expect(bySku.body.unit.code).toBe('pcs');
      await http().get('/api/v1/catalog/lookup?code=000000').set(kasir).expect(404);

      const list = await http().get('/api/v1/skus?q=089686010947').set(owner).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ displayName: 'Indomie Goreng', retailPrice: 3500, saleUnit: { code: 'pcs' } });
      const byName = await http().get('/api/v1/skus?q=indomie').set(owner).expect(200);
      expect(byName.body.pagination.total).toBe(2);
    });

    it('lets the cashier look items up but not change the catalogue', async () => {
      await http().post('/api/v1/products').set(kasir).send(indomie()).expect(403);
      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices`)
        .set(kasir)
        .send({ level: 'RETAIL', price: 1 })
        .expect(403);
    });

    it('changes prices now or on a future date, never backdated, keeping history', async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices`)
        .set(owner)
        .send({ level: 'RETAIL', price: 3700, effectiveFrom: tomorrow })
        .expect(201);
      let now = await http().get('/api/v1/catalog/lookup?code=089686010947').set(owner).expect(200);
      expect(now.body.prices.find((p: { level: string }) => p.level === 'RETAIL').price).toBe(3500);

      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices`)
        .set(owner)
        .send({ level: 'RETAIL', price: 3600 })
        .expect(201);
      now = await http().get('/api/v1/catalog/lookup?code=089686010947').set(owner).expect(200);
      expect(now.body.prices.find((p: { level: string }) => p.level === 'RETAIL').price).toBe(3600);

      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices`)
        .set(owner)
        .send({ level: 'RETAIL', price: 1000, effectiveFrom: '2020-01-01T00:00:00+07:00' })
        .expect(400);

      const history = await http().get(`/api/v1/skus/${goreng.skuId}/price-history`).set(owner).expect(200);
      expect(
        history.body.filter((h: { level: string; unitCode: string }) => h.level === 'RETAIL' && h.unitCode === 'pcs').map((h: { price: number }) => h.price),
      ).toEqual([3700, 3600, 3500]);
      const audit = await testQuery(`select 1 from audit_logs where action = 'price.change'`);
      expect(audit).toHaveLength(2);
    });

    it('removes a wholesale tier without deleting its history', async () => {
      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices/remove`)
        .set(owner)
        .send({ level: 'WHOLESALE', minQty: 10 })
        .expect(201);
      const now = await http().get('/api/v1/catalog/lookup?code=089686010947').set(owner).expect(200);
      expect(now.body.prices.map((p: { level: string }) => p.level).sort()).toEqual(['MEMBER', 'RETAIL']);
      await http()
        .post(`/api/v1/sku-units/${goreng.pcsUnitId}/prices/remove`)
        .set(owner)
        .send({ level: 'WHOLESALE', minQty: 10 })
        .expect(404);
    });

    it('adds a pack unit and replaces barcodes', async () => {
      const res = await http()
        .post(`/api/v1/skus/${goreng.skuId}/units`)
        .set(owner)
        .send({ unitId: unit.pack, factor: 5, barcodes: ['PACK-5'], prices: [{ level: 'RETAIL', price: 17000 }] })
        .expect(201);
      const pack = res.body.skus[0].units.find((u: { unit: { code: string } }) => u.unit.code === 'pack');
      await http()
        .put(`/api/v1/sku-units/${pack.id}/barcodes`)
        .set(owner)
        .send({ barcodes: ['PACK-5B'] })
        .expect(200);
      await http().get('/api/v1/catalog/lookup?code=PACK-5').set(owner).expect(404);
      await http().get('/api/v1/catalog/lookup?code=PACK-5B').set(owner).expect(200);
    });

    it('builds bundles only from standard items', async () => {
      const [soto] = await testQuery<{ id: string }>(`select id from skus where sku_code = 'IDM-SOTO'`);
      const bundle = await http()
        .post('/api/v1/products')
        .set(owner)
        .send({
          name: 'Paket Indomie',
          categoryId,
          skus: [{
            skuCode: 'PKT-IDM',
            kind: 'BUNDLE',
            isPurchasable: false,
            units: [{ unitId: unit.pack, factor: 1, isBase: true, barcodes: ['PKT-001'], prices: [{ level: 'RETAIL', price: 13000 }] }],
            components: [
              { componentSkuId: goreng.skuId, qty: 2 },
              { componentSkuId: soto.id, qty: 2 },
            ],
          }],
        })
        .expect(201);
      expect(bundle.body.skus[0].components.map((c: { displayName: string }) => c.displayName).sort()).toEqual([
        'Indomie Goreng',
        'Indomie Soto',
      ]);
      await http()
        .put(`/api/v1/skus/${bundle.body.skus[0].id}/components`)
        .set(owner)
        .send({ components: [{ componentSkuId: bundle.body.skus[0].id, qty: 1 }] })
        .expect(400);
    });
  });

  describe('promotions', () => {
    const base = {
      name: 'Diskon Mi',
      discountKind: 'PERCENT',
      discountValue: 10,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    it('validates the promo rules', async () => {
      const res = await http()
        .post('/api/v1/promotions')
        .set(owner)
        .send({ ...base, type: 'ITEM_DISCOUNT', discountValue: 150, timeStart: '10:00' })
        .expect(400);
      expect(res.body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
        'discountValue',
        'targets',
        'timeEnd',
      ]);
    });

    it('creates an item discount on a category and lists it as active', async () => {
      await http()
        .post('/api/v1/promotions')
        .set(owner)
        .send({ ...base, type: 'ITEM_DISCOUNT', targets: [{ targetType: 'CATEGORY', targetId: categoryId }] })
        .expect(201);
      await http()
        .post('/api/v1/promotions')
        .set(owner)
        .send({ ...base, name: 'Belanja 100rb', type: 'TOTAL_DISCOUNT', discountKind: 'AMOUNT', discountValue: 5000, minPurchase: 100000 })
        .expect(201);
      const active = await http().get('/api/v1/promotions?status=active').set(owner).expect(200);
      expect(active.body).toHaveLength(2);
      await http()
        .post('/api/v1/promotions')
        .set(owner)
        .send({ ...base, type: 'ITEM_DISCOUNT', targets: [{ targetType: 'SKU', targetId: categoryId }] })
        .expect(400);
    });
  });
});
