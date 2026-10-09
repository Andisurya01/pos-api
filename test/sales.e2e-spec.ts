import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { businessDate, docMonth } from '../src/common/business-date.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Sales at the register: post, PIN, void, return, shift close (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const yymm = docMonth(businessDate());
  let owner: { Authorization: string };
  let kasir: { Authorization: string };
  let ownerId: string;
  const loc: Record<string, string> = {};
  const unit: Record<string, string> = {};
  let tunai: string;
  let qris: string;
  let shiftId: string;
  let drawerCode: string;
  let expectedCash = 100000; // opening float
  let docsSale: { id: string; lines: { id: string }[] };
  let mixedSaleId: string;

  const login = async (username: string, password: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };
  const journalOf = (docNo: string) =>
    testQuery<{ code: string; debit: number; credit: number }>(
      `select a.code, l.debit::int, l.credit::int from journals j join journal_lines l on l.journal_id = j.id
       join accounts a on a.id = l.account_id where j.journal_no = $1 order by l.id`,
      [docNo],
    );
  const balanceOf = async (code: string) =>
    (await testQuery<{ v: number }>(`select coalesce(sum(l.debit - l.credit), 0)::bigint::int as v from journal_lines l join accounts a on a.id = l.account_id where a.code = $1`, [code]))[0].v;
  const stockAt = async (skuUnit: string, location: string) =>
    (await testQuery<{ q: string }>(
      `select coalesce(sum(b.qty), 0)::numeric(18,3)::text as q from stock_balances b join sku_units u on u.sku_id = b.sku_id where u.id = $1 and b.location_id = $2`,
      [skuUnit, location],
    ))[0].q;
  const pinFor = async (permissionCode: string) =>
    (await http().post('/api/v1/access/pin-approvals').set(kasir).send({ permissionCode, approverId: ownerId, pin: '135790' }).expect(201)).body.pinApprovalId;
  const sell = (body: object) => http().post('/api/v1/sales').set(kasir).send({ id: crypto.randomUUID(), ...body });

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await http().post('/api/v1/setup/owner').send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' }).expect(201);
    owner = await login('owner', 'owner-pass-123');
    await http().put('/api/v1/users/me/pin').set(owner).send({ pin: '135790' }).expect(204);
    ownerId = (await testQuery<{ id: string }>(`select id from users where username = 'owner'`))[0].id;
    const [k] = await testQuery<{ id: string }>(`insert into users (username, full_name, password_hash) values ('kasir', 'Kasir', $1) returning id`, [await hash('kasir-pass-1')]);
    await testQuery(`insert into user_roles (user_id, role_id) select $1, id from roles where name = 'Kasir'`, [k.id]);
    kasir = await login('kasir', 'kasir-pass-1');

    for (const [code, type] of [['GD', 'STORAGE'], ['DSP', 'DISPLAY'], ['RSK', 'DAMAGED']] as const) {
      loc[code] = (await http().post('/api/v1/locations').set(owner).send({ code, name: code, type }).expect(201)).body.id;
    }
    const units = (await http().get('/api/v1/units').set(owner)).body;
    const pcs = units.find((u: { code: string }) => u.code === 'pcs').id;
    const cat = (await http().post('/api/v1/categories').set(owner).send({ name: 'Sembako' }).expect(201)).body.id;
    const product = async (name: string, code: string, isTaxable: boolean, prices: object[]) => {
      const res = await http().post('/api/v1/products').set(owner).send({ name, categoryId: cat, skus: [{ skuCode: code, isTaxable, units: [{ unitId: pcs, factor: 1, isBase: true, prices }] }] }).expect(201);
      return { sku: res.body.skus[0].id, unit: res.body.skus[0].units[0].id };
    };
    const mie = await product('Indomie Goreng', 'MIE', true, [{ level: 'RETAIL', price: 3500 }, { level: 'MEMBER', price: 3400 }]);
    const gula = await product('Gula 1kg', 'GULA', false, [{ level: 'RETAIL', price: 12350 }]);
    unit.mie = mie.unit;
    unit.gula = gula.unit;
    // Opening stock: Indomie only in the warehouse (the shelf is empty), sugar on the shelf.
    const adj = crypto.randomUUID();
    await http().post('/api/v1/stock-adjustments').set(owner).send({ id: adj, reason: 'OPENING', lines: [
      { skuId: mie.sku, locationId: loc.GD, qty: 20, unitCost: 2900 },
      { skuId: gula.sku, locationId: loc.DSP, qty: 10, unitCost: 11000 },
    ] }).expect(201);
    await http().post(`/api/v1/stock-adjustments/${adj}/submit`).set(owner).expect(201);
    await http().post(`/api/v1/stock-adjustments/${adj}/approve`).set(owner).expect(201);

    const terminal = (await http().post('/api/v1/terminals').set(owner).send({ code: 'KSR01', name: 'Kasir 1', salesLocationId: loc.DSP, defaultFloat: 100000 }).expect(201)).body;
    drawerCode = 'KSR01';
    const methods = (await http().get('/api/v1/payment-methods').set(kasir)).body;
    tunai = methods.find((m: { code: string }) => m.code === 'TUNAI').id;
    qris = methods.find((m: { code: string }) => m.code === 'QRIS').id;
    shiftId = (await http().post('/api/v1/shifts/open').set(kasir).send({ id: crypto.randomUUID(), terminalId: terminal.id }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses to sell without an open shift', async () => {
    await http().post('/api/v1/sales').set(owner).send({ id: crypto.randomUUID(), lines: [{ skuUnitId: unit.gula, qty: 1 }], payments: [{ methodId: tunai, amount: 20000 }] }).expect(403);
  });

  it('posts the docs example: Rp47.350 paid in cash becomes Rp47.400, stock taken from the warehouse', async () => {
    const res = await sell({ lines: [{ skuUnitId: unit.mie, qty: 10 }, { skuUnitId: unit.gula, qty: 1 }], payments: [{ methodId: tunai, amount: 50000 }] }).expect(201);
    docsSale = res.body;
    expect(res.body).toMatchObject({ docNo: `PJ/${yymm}/00001`, netAmount: 47350, taxAmount: 3468, roundingAmount: 50, amountDue: 47400, changeAmount: 2600, costAmount: 40000 });
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: `1-1120-${drawerCode}`, debit: 47400, credit: 0 },
      { code: '4-1000', debit: 0, credit: 43882 },
      { code: '2-1300', debit: 0, credit: 3468 },
      { code: '4-2100', debit: 0, credit: 50 },
      { code: '5-1000', debit: 40000, credit: 0 },
      { code: '1-1400', debit: 0, credit: 40000 },
    ]);
    expect(await stockAt(unit.mie, loc.GD)).toBe('10.000');
    expectedCash += 47400;
  });

  it('takes QRIS exactly (with its reference) and the rest in cash', async () => {
    await sell({ lines: [{ skuUnitId: unit.mie, qty: 2 }], payments: [{ methodId: qris, amount: 5000 }, { methodId: tunai, amount: 2000 }] }).expect(400);
    const res = await sell({ lines: [{ skuUnitId: unit.mie, qty: 2 }], payments: [{ methodId: qris, amount: 5000, referenceNo: 'QR-001' }, { methodId: tunai, amount: 2000 }] }).expect(201);
    mixedSaleId = res.body.id;
    expect(res.body.payments.map((p: { kind: string; amount: number }) => [p.kind, p.amount]).sort()).toEqual([['CASH', 2000], ['QRIS', 5000]]);
    expect(await balanceOf('1-1310')).toBe(5000);
    expectedCash += 2000;
  });

  it('never stacks an item discount with a total discount', async () => {
    const [cat] = await testQuery<{ id: string }>(`select id from categories limit 1`);
    const period = { startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() };
    const item = (await http().post('/api/v1/promotions').set(owner).send({ name: 'Sembako 10%', type: 'ITEM_DISCOUNT', discountKind: 'PERCENT', discountValue: 10, ...period, targets: [{ targetType: 'CATEGORY', targetId: cat.id }] }).expect(201)).body;
    const total = (await http().post('/api/v1/promotions').set(owner).send({ name: 'Potongan 5rb', type: 'TOTAL_DISCOUNT', discountKind: 'AMOUNT', discountValue: 5000, minPurchase: 20000, ...period }).expect(201)).body;
    const res = await sell({ lines: [{ skuUnitId: unit.gula, qty: 2 }], payments: [{ methodId: tunai, amount: 20000 }] }).expect(201);
    expect(res.body).toMatchObject({ discountMode: 'TOTAL', promoDiscountAmount: 5000, netAmount: 19700, amountDue: 19700 });
    const [discount] = await journalOf(res.body.docNo).then((rows) => rows.filter((r) => r.code === '4-1100'));
    expect(discount.debit).toBe(5000); // non-taxable item: the discount has no PPN part
    expectedCash += 19700;
    for (const p of [item, total]) {
      await http().put(`/api/v1/promotions/${p.id}`).set(owner).send({ ...p, discountValue: Number(p.discountValue), isActive: false, startsAt: p.startsAt, endsAt: p.endsAt, targets: p.targets ?? [] }).expect(200);
    }
  });

  it('needs a supervisor PIN to sell more than the whole store holds', async () => {
    // Sugar left: 10 − 1 − 2 = 7 on the shelf; selling 9 runs 2 short.
    const denied = await sell({ lines: [{ skuUnitId: unit.gula, qty: 9 }], payments: [{ methodId: tunai, amount: 111200 }] }).expect(403);
    expect(denied.body.requiresPin).toBe('penjualan.kasir.jual_stok_minus');
    const stockPin = await pinFor('penjualan.kasir.jual_stok_minus');
    const res = await sell({ lines: [{ skuUnitId: unit.gula, qty: 9 }], stockPinApprovalId: stockPin, payments: [{ methodId: tunai, amount: 111200 }] }).expect(201);
    expect(res.body.amountDue).toBe(111200); // 111.150 → 111.200
    expect(await stockAt(unit.gula, loc.DSP)).toBe('-2.000');
    expectedCash += 111200;
  });

  it('voids a sale of the open shift: stock back, journal mirrored, only once', async () => {
    await http().post(`/api/v1/sales/${mixedSaleId}/void`).set(kasir).send({ reason: 'Salah input' }).expect(403);
    const voidPin = await pinFor('penjualan.transaksi.void');
    const res = await http().post(`/api/v1/sales/${mixedSaleId}/void`).set(kasir).send({ reason: 'Salah input', pinApprovalId: voidPin }).expect(201);
    expect(res.body.status).toBe('VOIDED');
    expect(await stockAt(unit.mie, loc.GD)).toBe('10.000');
    expect(await balanceOf('1-1310')).toBe(0);
    expectedCash -= 2000;
    const againPin = await pinFor('penjualan.transaksi.void');
    await http().post(`/api/v1/sales/${mixedSaleId}/void`).set(kasir).send({ reason: 'Lagi', pinApprovalId: againPin }).expect(400);
  });

  it('returns part of a sale at the price paid and the original cost', async () => {
    const line = docsSale.lines[0]; // Indomie 10 pcs, net 35.000 incl. PPN 3.468, cost 29.000
    const returnPin = await pinFor('penjualan.retur.buat');
    const res = await http()
      .post('/api/v1/sales-returns')
      .set(kasir)
      .send({ id: crypto.randomUUID(), saleId: docsSale.id, reason: 'Kemasan sobek', pinApprovalId: returnPin, lines: [{ saleLineId: line.id, baseQty: 2, condition: 'SELLABLE' }] })
      .expect(201);
    expect(res.body).toMatchObject({ refundAmount: 7000, taxAmount: 694, roundingAmount: 0, cashRefund: 7000 });
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '4-1200', debit: 6306, credit: 0 },
      { code: '2-1300', debit: 694, credit: 0 },
      { code: `1-1120-${drawerCode}`, debit: 0, credit: 7000 },
      { code: '1-1400', debit: 5800, credit: 0 },
      { code: '5-1000', debit: 0, credit: 5800 },
    ]);
    expect(await stockAt(unit.mie, loc.DSP)).toBe('2.000');
    expectedCash -= 7000;
    const secondPin = await pinFor('penjualan.retur.buat');
    await http()
      .post('/api/v1/sales-returns')
      .set(kasir)
      .send({ id: crypto.randomUUID(), saleId: docsSale.id, reason: 'Lebih', pinApprovalId: secondPin, lines: [{ saleLineId: line.id, baseQty: 9, condition: 'DAMAGED' }] })
      .expect(400);
  });

  it('keeps held carts until the shift closes, and the drawer matches every cash movement', async () => {
    await http().post('/api/v1/held-sales').set(kasir).send({ id: crypto.randomUUID(), label: 'Bu Sari', cart: [{ skuUnitId: unit.mie, qty: 1 }] }).expect(201);
    expect((await http().get('/api/v1/held-sales').set(kasir)).body).toHaveLength(1);
    const closed = await http().post(`/api/v1/shifts/${shiftId}/close`).set(kasir).send({ countedCash: expectedCash, depositAmount: expectedCash }).expect(201);
    expect(closed.body).toMatchObject({ expectedCash, cashDifference: 0 });
    expect((await testQuery(`select 1 from held_sales`)).length).toBe(0);
  });

  it('keeps stock value and the general ledger in agreement', async () => {
    const [ledger] = await testQuery<{ v: number }>(`select sum(value)::bigint::int as v from stock_ledger`);
    expect(ledger.v).toBe(await balanceOf('1-1400'));
    expect(await balanceOf(`1-1120-${drawerCode}`)).toBe(0); // everything deposited
  });
});
