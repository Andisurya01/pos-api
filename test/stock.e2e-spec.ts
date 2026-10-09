import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { businessDate, docMonth } from '../src/common/business-date.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Warehouse: opening stock, transfers, adjustments, valuation (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  let owner: { Authorization: string };
  let gudang: { Authorization: string };
  let kasir: { Authorization: string };
  const loc: Record<string, string> = {};
  const sku: Record<string, string> = {};
  const yymm = docMonth(businessDate());

  const login = async (username: string, password: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };
  const addUser = async (username: string, role: string) => {
    const [u] = await testQuery<{ id: string }>(
      `insert into users (username, full_name, password_hash) values ($1, $1, $2) returning id`,
      [username, await hash(`${username}-pass-1`)],
    );
    await testQuery(`insert into user_roles (user_id, role_id) select $1, id from roles where name = $2`, [u.id, role]);
    return login(username, `${username}-pass-1`);
  };

  /** Draft → submit → approve, returning the posted document. */
  const postAdjustment = async (body: object, expected: number, creator = owner, approver = owner) => {
    const id = crypto.randomUUID();
    await http().post('/api/v1/stock-adjustments').set(creator).send({ id, ...body }).expect(201);
    await http().post(`/api/v1/stock-adjustments/${id}/submit`).set(creator).expect(201);
    return http().post(`/api/v1/stock-adjustments/${id}/approve`).set(approver).expect(expected);
  };

  const balance = async (skuId: string, locationId: string) => {
    const res = await http().get(`/api/v1/stock/balances?skuId=${skuId}&locationId=${locationId}&includeZero=true`).set(owner).expect(200);
    return res.body.map((b: { qty: string }) => b.qty);
  };

  const journalOf = async (docNo: string) =>
    testQuery<{ code: string; debit: number; credit: number }>(
      `select a.code, l.debit::int, l.credit::int from journals j
       join journal_lines l on l.journal_id = j.id join accounts a on a.id = l.account_id
       where j.journal_no = $1 order by l.id`,
      [docNo],
    );

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await http().post('/api/v1/setup/owner').send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' }).expect(201);
    owner = await login('owner', 'owner-pass-123');
    gudang = await addUser('gudang', 'Gudang');
    kasir = await addUser('kasir', 'Kasir');

    for (const [code, type] of [['GD', 'STORAGE'], ['DSP', 'DISPLAY'], ['RSK', 'DAMAGED']] as const) {
      const res = await http().post('/api/v1/locations').set(owner).send({ code, name: code, type }).expect(201);
      loc[code] = res.body.id;
    }
    const units = await http().get('/api/v1/units').set(owner).expect(200);
    const unit = (code: string) => units.body.find((u: { code: string }) => u.code === code).id;
    const cat = await http().post('/api/v1/categories').set(owner).send({ name: 'Sembako' }).expect(201);
    const product = (name: string, skuCode: string, unitCode: string, extra = {}) =>
      http()
        .post('/api/v1/products')
        .set(owner)
        .send({ name, categoryId: cat.body.id, skus: [{ skuCode, ...extra, units: [{ unitId: unit(unitCode), factor: 1, isBase: true, prices: [{ level: 'RETAIL', price: 5000 }] }] }] })
        .expect(201);
    sku.mie = (await product('Indomie Goreng', 'MIE', 'pcs')).body.skus[0].id;
    sku.beras = (await product('Beras Curah', 'BERAS', 'kg', { isWeighed: true })).body.skus[0].id;
    sku.susu = (await product('Susu UHT', 'SUSU', 'pcs', { trackBatch: true })).body.skus[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('posts opening stock: ledger, valuation and journal against Ekuitas Saldo Awal', async () => {
    const res = await postAdjustment({
      reason: 'OPENING',
      lines: [
        { skuId: sku.mie, locationId: loc.GD, qty: 40, unitCost: 2900 },
        { skuId: sku.beras, locationId: loc.GD, qty: '25', unitCost: '14500' },
        { skuId: sku.susu, locationId: loc.GD, qty: 10, unitCost: 5000, batchNo: 'B1', expiryDate: '2027-01-01' },
      ],
    }, 201);
    expect(res.body).toMatchObject({ status: 'POSTED', docNo: `SA/${yymm}/00001` });
    expect(res.body.lines.map((l: { value: number }) => l.value)).toEqual([116000, 362500, 50000]);
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '1-1400', debit: 528500, credit: 0 },
      { code: '3-9000', debit: 0, credit: 528500 },
    ]);
    const [val] = await testQuery<{ qty: string; value: number; last_avg_cost: string }>(
      `select qty, value::int, last_avg_cost from sku_valuations where sku_id = $1`,
      [sku.mie],
    );
    expect(val).toEqual({ qty: '40.000', value: 116000, last_avg_cost: '2900.0000' });
  });

  it('moves stock between locations without touching value or the journal', async () => {
    const res = await http()
      .post('/api/v1/stock-transfers')
      .set(gudang)
      .send({ id: crypto.randomUUID(), fromLocationId: loc.GD, toLocationId: loc.DSP, lines: [{ skuId: sku.mie, qty: 12 }] })
      .expect(201);
    expect(res.body.docNo).toBe(`PM/${yymm}/00001`);
    expect(await balance(sku.mie, loc.GD)).toEqual(['28.000']);
    expect(await balance(sku.mie, loc.DSP)).toEqual(['12.000']);
    expect(await journalOf(res.body.docNo)).toEqual([]);
    await http()
      .post('/api/v1/stock-transfers')
      .set(gudang)
      .send({ id: crypto.randomUUID(), fromLocationId: loc.GD, toLocationId: loc.DSP, lines: [{ skuId: sku.mie, qty: 29 }] })
      .expect(400);
  });

  it('writes off damaged goods at moving-average cost', async () => {
    const res = await postAdjustment({ reason: 'DAMAGED', lines: [{ skuId: sku.mie, locationId: loc.DSP, qty: -2 }] }, 201);
    expect(res.body.docNo).toBe(`PS/${yymm}/00001`);
    expect(await journalOf(res.body.docNo)).toEqual([
      { code: '6-2200', debit: 5800, credit: 0 },
      { code: '1-1400', debit: 0, credit: 5800 },
    ]);
    expect(await balance(sku.mie, loc.DSP)).toEqual(['10.000']);
  });

  it('weighs goods in grams and requires the batch for batch-tracked items', async () => {
    const res = await postAdjustment({ reason: 'SELF_USE', lines: [{ skuId: sku.beras, locationId: loc.GD, qty: '-1.255' }] }, 201);
    expect(res.body.lines[0].value).toBe(-18198);
    const [batch] = await testQuery<{ id: string }>(`select id from batches where sku_id = $1`, [sku.susu]);
    const id = crypto.randomUUID();
    const noBatch = await http()
      .post('/api/v1/stock-adjustments')
      .set(owner)
      .send({ id, reason: 'EXPIRED', lines: [{ skuId: sku.susu, locationId: loc.GD, qty: -1 }] })
      .expect(400);
    expect(noBatch.body.message).toContain('pilih batch');
    await postAdjustment({ reason: 'EXPIRED', lines: [{ skuId: sku.susu, locationId: loc.GD, qty: -1, batchId: batch.id }] }, 201);
  });

  it.each([
    ['a found item with negative quantity', { reason: 'FOUND', lines: [{ qty: -1 }] }, 'stok bertambah'],
    ['a fraction of a pcs item', { reason: 'LOST', lines: [{ qty: '-0.5' }] }, 'bilangan bulat'],
  ])('rejects %s', async (_label, body, message) => {
    const b = body as { reason: string; lines: Array<{ qty: number | string }> };
    const res = await http()
      .post('/api/v1/stock-adjustments')
      .set(owner)
      .send({ id: crypto.randomUUID(), reason: b.reason, lines: b.lines.map((l) => ({ ...l, skuId: sku.mie, locationId: loc.GD })) })
      .expect(400);
    expect(res.body.message).toContain(message);
  });

  it('rolls everything back when one line lacks stock', async () => {
    const before = await testQuery(`select count(*)::int as n from stock_ledger`);
    await postAdjustment({
      reason: 'LOST',
      lines: [
        { skuId: sku.beras, locationId: loc.GD, qty: -1 },
        { skuId: sku.mie, locationId: loc.GD, qty: -999 },
      ],
    }, 400);
    expect(await testQuery(`select count(*)::int as n from stock_ledger`)).toEqual(before);
  });

  it('separates who may create and who may approve', async () => {
    await http()
      .post('/api/v1/stock-adjustments')
      .set(kasir)
      .send({ id: crypto.randomUUID(), reason: 'LOST', lines: [{ skuId: sku.mie, locationId: loc.GD, qty: -1 }] })
      .expect(403);
    // Gudang may enter opening stock but not approve it.
    await postAdjustment({ reason: 'OPENING', lines: [{ skuId: sku.mie, locationId: loc.GD, qty: 1, unitCost: 3000 }] }, 403, gudang, gudang);
  });

  it('shows the kartu stok with running balances, values only to those allowed', async () => {
    const today = businessDate();
    const full = await http().get(`/api/v1/stock/card?skuId=${sku.mie}&from=${today}&to=${today}`).set(owner).expect(200);
    expect(full.body.movements.map((m: { movement: string; balance: string }) => [m.movement, m.balance])).toEqual([
      ['OPENING', '40.000'],
      ['TRANSFER_OUT', '28.000'],
      ['TRANSFER_IN', '40.000'],
      ['ADJUSTMENT', '38.000'],
    ]);
    expect(full.body.closingValue).toBe(110200);
    const limited = await http().get(`/api/v1/stock/card?skuId=${sku.mie}&from=${today}&to=${today}`).set(gudang).expect(200);
    expect(limited.body.closingValue).toBeUndefined();
    expect(limited.body.movements[0].value).toBeUndefined();
  });

  it('keeps the stock ledger, balances, valuations and the Persediaan account in agreement', async () => {
    const [ledger] = await testQuery<{ value: number }>(`select coalesce(sum(value), 0)::bigint::int as value from stock_ledger`);
    const [account] = await testQuery<{ value: number }>(
      `select coalesce(sum(debit - credit), 0)::bigint::int as value from journal_lines l
       join accounts a on a.id = l.account_id where a.code = '1-1400'`,
    );
    const [valuation] = await testQuery<{ value: number }>(`select sum(value)::bigint::int as value from sku_valuations`);
    expect(ledger.value).toBe(account.value);
    expect(valuation.value).toBe(account.value);
    const mismatches = await testQuery(
      `select s.id from skus s
        where coalesce((select sum(qty) from stock_ledger where sku_id = s.id), 0)
           <> coalesce((select sum(qty) from stock_balances where sku_id = s.id), 0)
           or coalesce((select sum(qty) from stock_ledger where sku_id = s.id), 0)
           <> coalesce((select qty from sku_valuations where sku_id = s.id), 0)`,
    );
    expect(mismatches).toEqual([]);
    await expect(testQuery(`update stock_ledger set qty = qty + 1`)).rejects.toThrow('append-only');
  });

  describe('stock opname', () => {
    it('counts while the store keeps moving stock, then settles the differences in one posting', async () => {
      const id = crypto.randomUUID();
      await http().post('/api/v1/stock-opnames').set(gudang).send({ id, scopeLocationIds: [loc.GD] }).expect(201);
      await http().put(`/api/v1/stock-opnames/${id}/counts`).set(gudang).send({ counts: [{ skuId: sku.mie, locationId: loc.GD, countedQty: 1 }] }).expect(400); // not started
      await http().post(`/api/v1/stock-opnames/${id}/start`).set(gudang).expect(201);
      await http()
        .put(`/api/v1/stock-opnames/${id}/counts`)
        .set(gudang)
        .send({ counts: [{ skuId: sku.mie, locationId: loc.DSP, countedQty: 1 }] })
        .expect(400); // outside the scope
      await http()
        .put(`/api/v1/stock-opnames/${id}/counts`)
        .set(kasir)
        .send({ counts: [{ skuId: sku.mie, locationId: loc.GD, countedQty: 27 }] })
        .expect(403);
      await http()
        .put(`/api/v1/stock-opnames/${id}/counts`)
        .set(gudang)
        .send({ counts: [{ skuId: sku.mie, locationId: loc.GD, countedQty: 27 }, { skuId: sku.beras, locationId: loc.GD, countedQty: '23.8' }] })
        .expect(200);

      // Someone restocks the shelf after the warehouse was counted.
      await http()
        .post('/api/v1/stock-transfers')
        .set(gudang)
        .send({ id: crypto.randomUUID(), fromLocationId: loc.GD, toLocationId: loc.DSP, lines: [{ skuId: sku.mie, qty: 3 }] })
        .expect(201);

      // Nobody counted the milk: ZERO treats it as gone.
      const submitted = await http().post(`/api/v1/stock-opnames/${id}/submit`).set(gudang).send({ uncountedPolicy: 'ZERO' }).expect(201);
      const diff = (skuId: string) => submitted.body.lines.find((l: { skuId: string }) => l.skuId === skuId);
      expect(diff(sku.mie)).toMatchObject({ systemQty: '28.000', countedQty: '27.000', diffQty: '-1.000' });
      expect(diff(sku.beras)).toMatchObject({ systemQty: '23.745', diffQty: '0.055' });
      expect(diff(sku.susu)).toMatchObject({ systemQty: '9.000', countedQty: '0.000', diffQty: '-9.000' });

      const owners = await http().get(`/api/v1/stock-opnames/${id}`).set(owner).expect(200);
      expect(owners.body.lines[0]).toMatchObject({ skuId: sku.susu, diffValue: -45000 }); // largest difference first

      const posted = await http().post(`/api/v1/stock-opnames/${id}/approve`).set(gudang).expect(201);
      expect(posted.body).toMatchObject({ status: 'POSTED', docNo: `SO/${yymm}/00001` });
      const [adj] = await testQuery<{ doc_no: string }>(`select doc_no from stock_adjustments where id = $1`, [posted.body.adjustmentId]);
      expect(await journalOf(adj.doc_no)).toEqual([
        { code: '6-2100', debit: 47900, credit: 0 },
        { code: '1-1400', debit: 0, credit: 47900 },
        { code: '1-1400', debit: 797, credit: 0 }, // 0.055 kg × avg 14499.9789 after the earlier rounded issue
        { code: '4-2300', debit: 0, credit: 797 },
      ]);
      // Physical 27 minus the 3 moved later = 24 left in the warehouse.
      expect(await balance(sku.mie, loc.GD)).toEqual(['24.000']);
      expect(await balance(sku.beras, loc.GD)).toEqual(['23.800']);
      expect(await balance(sku.susu, loc.GD)).toEqual(['0.000']);

      const [ledger] = await testQuery<{ value: number }>(`select sum(value)::bigint::int as value from stock_ledger`);
      const [account] = await testQuery<{ value: number }>(
        `select sum(debit - credit)::bigint::int as value from journal_lines l join accounts a on a.id = l.account_id where a.code = '1-1400'`,
      );
      expect(ledger.value).toBe(account.value);
    });

    it('can be sent back for recounting or cancelled, but not approved twice', async () => {
      const id = crypto.randomUUID();
      await http().post('/api/v1/stock-opnames').set(gudang).send({ id, scopeLocationIds: [loc.DSP] }).expect(201);
      await http().post(`/api/v1/stock-opnames/${id}/start`).set(gudang).expect(201);
      await http().put(`/api/v1/stock-opnames/${id}/counts`).set(gudang).send({ counts: [{ skuId: sku.mie, locationId: loc.DSP, countedQty: 99 }] }).expect(200);
      await http().post(`/api/v1/stock-opnames/${id}/submit`).set(gudang).send({}).expect(201);
      await http().post(`/api/v1/stock-opnames/${id}/reopen`).set(gudang).expect(201);
      await http().put(`/api/v1/stock-opnames/${id}/counts`).set(gudang).send({ counts: [{ skuId: sku.mie, locationId: loc.DSP, countedQty: 13 }] }).expect(200);
      const res = await http().post(`/api/v1/stock-opnames/${id}/submit`).set(gudang).send({}).expect(201);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.lines[0]).toMatchObject({ countedQty: '13.000', systemQty: '13.000', diffQty: '0.000' });
      const approved = await http().post(`/api/v1/stock-opnames/${id}/approve`).set(gudang).expect(201);
      expect(approved.body.adjustmentId).toBeNull(); // nothing to adjust
      await http().post(`/api/v1/stock-opnames/${id}/approve`).set(gudang).expect(400);
      await http().post(`/api/v1/stock-opnames/${id}/cancel`).set(gudang).expect(400);
    });
  });
});
