import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { businessDate, docMonth } from '../src/common/business-date.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Purchasing: PO → receipt → bill → return → payment (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  let owner: { Authorization: string };
  let gudang: { Authorization: string };
  const yymm = docMonth(businessDate());
  let gd: string;
  let pcs: string;
  let dus: string;
  let skuId: string;
  let pkp: string;
  let warung: string;
  let cashAccount: string;
  let poId: string;
  const receiptLines: string[] = [];
  let billId: string;
  let returnId: string;

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
    (await testQuery<{ v: number }>(
      `select coalesce(sum(l.debit - l.credit), 0)::bigint::int as v from journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
      [code],
    ))[0].v;

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await http().post('/api/v1/setup/owner').send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' }).expect(201);
    owner = await login('owner', 'owner-pass-123');
    const [g] = await testQuery<{ id: string }>(`insert into users (username, full_name, password_hash) values ('gudang', 'Gudang', $1) returning id`, [await hash('gudang-pass-1')]);
    await testQuery(`insert into user_roles (user_id, role_id) select $1, id from roles where name = 'Gudang'`, [g.id]);
    gudang = await login('gudang', 'gudang-pass-1');

    gd = (await http().post('/api/v1/locations').set(owner).send({ code: 'GD', name: 'Gudang', type: 'STORAGE' }).expect(201)).body.id;
    const units = (await http().get('/api/v1/units').set(owner).expect(200)).body;
    const unit = (c: string) => units.find((u: { code: string }) => u.code === c).id;
    const cat = (await http().post('/api/v1/categories').set(owner).send({ name: 'Mi' }).expect(201)).body.id;
    const product = await http()
      .post('/api/v1/products')
      .set(owner)
      .send({
        name: 'Indomie Goreng',
        categoryId: cat,
        skus: [{
          skuCode: 'MIE',
          units: [
            { unitId: unit('pcs'), factor: 1, isBase: true, prices: [{ level: 'RETAIL', price: 3500 }] },
            { unitId: unit('dus'), factor: 40, isDefaultPurchase: true },
          ],
        }],
      })
      .expect(201);
    skuId = product.body.skus[0].id;
    pcs = product.body.skus[0].units.find((u: { unit: { code: string } }) => u.unit.code === 'pcs').id;
    dus = product.body.skus[0].units.find((u: { unit: { code: string } }) => u.unit.code === 'dus').id;
    pkp = (await http().post('/api/v1/suppliers').set(owner).send({ code: 'IDM', name: 'PT Indomarco', isPkp: true, npwp: '01.234', paymentTermDays: 30 }).expect(201)).body.id;
    warung = (await http().post('/api/v1/suppliers').set(owner).send({ code: 'WRG', name: 'Sales Kanvas' }).expect(201)).body.id;
    cashAccount = (await testQuery<{ id: string }>(`select id from accounts where code = '1-1100'`))[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs a PO through submit and approval, numbering it on approval', async () => {
    poId = crypto.randomUUID();
    const draft = await http().post('/api/v1/purchase-orders').set(gudang).send({ id: poId, supplierId: pkp, lines: [{ skuUnitId: dus, qty: 2, unitPrice: 120000 }] }).expect(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', subtotal: 240000 });
    expect(draft.body.lines[0]).toMatchObject({ baseQty: '80.000', remainingBaseQty: '80.000' });
    await http().post(`/api/v1/purchase-orders/${poId}/submit`).set(gudang).expect(201);
    await http().post(`/api/v1/purchase-orders/${poId}/approve`).set(gudang).expect(403);
    const approved = await http().post(`/api/v1/purchase-orders/${poId}/approve`).set(owner).expect(201);
    expect(approved.body).toMatchObject({ status: 'APPROVED', docNo: `PO/${yymm}/00001` });
  });

  it('receives goods in parts, valuing stock at the PO price', async () => {
    const po = (await http().get(`/api/v1/purchase-orders/${poId}`).set(owner).expect(200)).body;
    const res = await http()
      .post('/api/v1/goods-receipts')
      .set(gudang)
      .send({ id: crypto.randomUUID(), supplierId: pkp, poId, lines: [{ poLineId: po.lines[0].id, qty: 1, locationId: gd }] })
      .expect(201);
    receiptLines.push(res.body.lines[0].id);
    expect(res.body.docNo).toBe(`PB/${yymm}/00001`);
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '1-1400', debit: 120000, credit: 0 },
      { code: '2-1200', debit: 0, credit: 120000 },
    ]);
    const [val] = await testQuery(`select qty, value::int, last_avg_cost, last_purchase_cost, highest_purchase_cost from sku_valuations where sku_id = $1`, [skuId]);
    expect(val).toEqual({ qty: '40.000', value: 120000, last_avg_cost: '3000.0000', last_purchase_cost: '3000.0000', highest_purchase_cost: '3000.0000' });
    expect((await http().get(`/api/v1/purchase-orders/${poId}`).set(owner)).body.status).toBe('PARTIALLY_RECEIVED');

    // More than what is left on the PO needs a supervisor PIN.
    const over = await http()
      .post('/api/v1/goods-receipts')
      .set(gudang)
      .send({ id: crypto.randomUUID(), supplierId: pkp, poId, lines: [{ poLineId: po.lines[0].id, qty: 2, locationId: gd }] })
      .expect(403);
    expect(over.body.requiresPin).toBe('pembelian.penerimaan.lebih_dari_po');

    const rest = await http()
      .post('/api/v1/goods-receipts')
      .set(gudang)
      .send({ id: crypto.randomUUID(), supplierId: pkp, poId, lines: [{ poLineId: po.lines[0].id, qty: 1, locationId: gd }] })
      .expect(201);
    receiptLines.push(rest.body.lines[0].id);
    expect((await http().get(`/api/v1/purchase-orders/${poId}`).set(owner)).body.status).toBe('RECEIVED');
  });

  it('books the bill: price variance and shipping go into stock value, PPN masukan, payable', async () => {
    billId = crypto.randomUUID();
    const res = await http()
      .post('/api/v1/supplier-bills')
      .set(owner)
      .send({
        id: billId,
        supplierId: pkp,
        supplierInvoiceNo: 'INV-889',
        taxInvoiceNo: '010.000-26.00000001',
        shippingCost: 4000,
        taxAmount: 26620,
        lines: [
          { receiptLineId: receiptLines[0], qty: 1, unitPrice: 121000 },
          { receiptLineId: receiptLines[1], qty: 1, unitPrice: 120000 },
        ],
      })
      .expect(201);
    expect(res.body).toMatchObject({ docNo: `TG/${yymm}/00001`, subtotal: 241000, total: 271620, outstanding: 271620 });
    expect(res.body.dueDate > res.body.billDate).toBe(true); // 30-day term
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '2-1200', debit: 240000, credit: 0 },
      { code: '1-1500', debit: 26620, credit: 0 },
      { code: '1-1400', debit: 5000, credit: 0 },
      { code: '2-1100', debit: 0, credit: 271620 },
    ]);
    const [val] = await testQuery(`select value::int, last_avg_cost from sku_valuations where sku_id = $1`, [skuId]);
    expect(val).toEqual({ value: 245000, last_avg_cost: '3062.5000' });
    expect(await balanceOf('2-1200')).toBe(0); // everything received is billed

    await http()
      .post('/api/v1/supplier-bills')
      .set(owner)
      .send({ id: crypto.randomUUID(), supplierId: pkp, supplierInvoiceNo: 'INV-890', lines: [{ receiptLineId: receiptLines[0], qty: 1, unitPrice: 1 }] })
      .expect(400);
  });

  it('returns goods at moving-average cost and issues a debit note against the payable', async () => {
    returnId = crypto.randomUUID();
    const res = await http()
      .post('/api/v1/purchase-returns')
      .set(owner)
      .send({ id: returnId, supplierId: pkp, fromLocationId: gd, taxAmount: 3300, lines: [{ receiptLineId: receiptLines[0], baseQty: 10 }] })
      .expect(201);
    expect(res.body).toMatchObject({ docNo: `RB/${yymm}/00001`, reduces: 'PAYABLE', debitNoteAmount: 33300 });
    expect(res.body.lines[0]).toMatchObject({ lineAmount: 30000, costAmount: 30625, variance: -625 });
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '2-1100', debit: 33300, credit: 0 },
      { code: '1-1400', debit: 0, credit: 30625 },
      { code: '1-1500', debit: 0, credit: 3300 },
      { code: '5-1100', debit: 625, credit: 0 },
    ]);
  });

  it('pays the bill with money plus the debit note, leaving nothing owed', async () => {
    await http()
      .post('/api/v1/supplier-payments')
      .set(owner)
      .send({ id: crypto.randomUUID(), supplierId: pkp, sourceAccountId: cashAccount, allocations: [{ billId, amount: 300000 }] })
      .expect(400); // more than outstanding
    const res = await http()
      .post('/api/v1/supplier-payments')
      .set(owner)
      .send({
        id: crypto.randomUUID(),
        supplierId: pkp,
        sourceAccountId: cashAccount,
        allocations: [{ billId, amount: 238320 }],
        debitNotes: [{ purchaseReturnId: returnId, billId, amount: 33300 }],
      })
      .expect(201);
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '2-1100', debit: 238320, credit: 0 },
      { code: '1-1100', debit: 0, credit: 238320 },
    ]);
    const bill = await http().get(`/api/v1/supplier-bills/${billId}`).set(owner).expect(200);
    expect(bill.body).toMatchObject({ status: 'PAID', outstanding: 0 });
    expect((await http().get(`/api/v1/purchase-returns/${returnId}`).set(owner)).body.remainingDebitNote).toBe(0);
    expect(await balanceOf('2-1100')).toBe(0);
    expect((await http().get(`/api/v1/suppliers/${pkp}/open-bills`).set(owner)).body).toEqual([]);
  });

  it('handles a direct receipt from a non-PKP supplier, creating the bill at once', async () => {
    const body = (taxAmount: number) => ({
      id: crypto.randomUUID(),
      supplierId: warung,
      lines: [{ skuUnitId: pcs, qty: 5, unitPrice: 3500, locationId: gd }],
      bill: { supplierInvoiceNo: 'NOTA-1', taxAmount },
    });
    await http().post('/api/v1/goods-receipts').set(owner).send(body(100)).expect(400);
    const res = await http().post('/api/v1/goods-receipts').set(owner).send(body(0)).expect(201);
    expect(res.body).toMatchObject({ isDirect: true, totalValue: 17500 });
    const bill = await http().get(`/api/v1/supplier-bills/${res.body.directBillId}`).set(owner).expect(200);
    expect(bill.body).toMatchObject({ total: 17500, supplierInvoiceNo: 'NOTA-1' });
    const [val] = await testQuery(`select highest_purchase_cost, last_purchase_cost from sku_valuations where sku_id = $1`, [skuId]);
    expect(val).toEqual({ highest_purchase_cost: '3500.0000', last_purchase_cost: '3500.0000' });
    expect(await balanceOf('2-1100')).toBe(-17500); // payable = credit balance (debit − credit)
  });

  it('keeps stock, valuation and the general ledger in agreement', async () => {
    const [ledger] = await testQuery<{ v: number }>(`select sum(value)::bigint::int as v from stock_ledger`);
    expect(ledger.v).toBe(await balanceOf('1-1400'));
    const [val] = await testQuery<{ v: number }>(`select sum(value)::bigint::int as v from sku_valuations`);
    expect(val.v).toBe(ledger.v);
  });
});
