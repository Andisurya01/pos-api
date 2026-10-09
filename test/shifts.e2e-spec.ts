import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Cash drawers and shifts (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  let owner: { Authorization: string };
  let kasir: { Authorization: string };
  let kasir2: { Authorization: string };
  let terminalId: string;
  let drawerCode: string;

  const login = async (username: string, password: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };
  const addUser = async (username: string, role: string) => {
    const [u] = await testQuery<{ id: string }>(`insert into users (username, full_name, password_hash) values ($1, $1, $2) returning id`, [username, await hash(`${username}-pass-1`)]);
    await testQuery(`insert into user_roles (user_id, role_id) select $1, id from roles where name = $2`, [u.id, role]);
    return u.id;
  };
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
    await addUser('kasir', 'Kasir');
    await addUser('kasir2', 'Kasir');
    kasir = await login('kasir', 'kasir-pass-1');
    kasir2 = await login('kasir2', 'kasir2-pass-1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets up a drawer with its own ledger account and the default payment methods', async () => {
    const storage = await http().post('/api/v1/locations').set(owner).send({ code: 'GD', name: 'Gudang', type: 'STORAGE' }).expect(201);
    await http().post('/api/v1/terminals').set(owner).send({ code: 'KSR01', name: 'Kasir 1', salesLocationId: storage.body.id }).expect(400);
    const display = await http().post('/api/v1/locations').set(owner).send({ code: 'DSP', name: 'Display', type: 'DISPLAY' }).expect(201);
    const res = await http().post('/api/v1/terminals').set(owner).send({ code: 'KSR01', name: 'Kasir 1', salesLocationId: display.body.id, defaultFloat: 200000 }).expect(201);
    terminalId = res.body.id;
    const [account] = await testQuery<{ code: string; is_control: boolean; cash_kind: string }>(`select code, is_control, cash_kind from accounts where id = $1`, [res.body.cashAccountId]);
    expect(account).toEqual({ code: '1-1120-KSR01', is_control: true, cash_kind: 'DRAWER' });
    drawerCode = account.code;

    const methods = await http().get('/api/v1/payment-methods').set(kasir).expect(200);
    expect(methods.body.map((m: { code: string }) => m.code)).toEqual(['TUNAI', 'QRIS', 'KARTU']);
    await http().post('/api/v1/payment-methods').set(owner).send({ code: 'TRF', name: 'Transfer', kind: 'TRANSFER' }).expect(400);
  });

  it('opens a shift with the default float taken from kas besar, one shift per drawer and per cashier', async () => {
    const res = await http().post('/api/v1/shifts/open').set(kasir).send({ id: crypto.randomUUID(), terminalId }).expect(201);
    expect(res.body).toMatchObject({ status: 'OPEN', openingFloat: 200000, drawerBalance: 200000 });
    expect(await balanceOf(drawerCode)).toBe(200000);
    expect(await balanceOf('1-1100')).toBe(-200000);
    await http().post('/api/v1/shifts/open').set(kasir2).send({ id: crypto.randomUUID(), terminalId }).expect(409);
    const current = await http().get('/api/v1/shifts/current').set(kasir).expect(200);
    expect(current.body.id).toBe(res.body.id);
  });

  it('moves cash between the drawer and kas besar, never below zero', async () => {
    const shift = (await http().get('/api/v1/shifts/current').set(kasir)).body;
    await http().post(`/api/v1/shifts/${shift.id}/cash-movements`).set(kasir).send({ kind: 'CASH_OUT', amount: 50000, reason: 'Setor tengah shift' }).expect(201);
    await http().post(`/api/v1/shifts/${shift.id}/cash-movements`).set(kasir).send({ kind: 'CASH_OUT', amount: 999999, reason: 'Terlalu banyak' }).expect(400);
    await http().post(`/api/v1/shifts/${shift.id}/cash-movements`).set(kasir2).send({ kind: 'CASH_IN', amount: 1000, reason: 'Bukan shift saya' }).expect(403);
    expect(await balanceOf(drawerCode)).toBe(150000);
  });

  it('opens the drawer without a sale only with a supervisor PIN', async () => {
    const shift = (await http().get('/api/v1/shifts/current').set(kasir)).body;
    const denied = await http().post(`/api/v1/shifts/${shift.id}/open-drawer`).set(kasir).send({ reason: 'Tukar uang' }).expect(403);
    expect(denied.body.requiresPin).toBe('penjualan.kasir.buka_laci');
    await http().put('/api/v1/users/me/pin').set(owner).send({ pin: '135790' }).expect(204);
    const [ownerUser] = await testQuery<{ id: string }>(`select id from users where username = 'owner'`);
    const approval = await http()
      .post('/api/v1/access/pin-approvals')
      .set(kasir)
      .send({ permissionCode: 'penjualan.kasir.buka_laci', approverId: ownerUser.id, pin: '135790' })
      .expect(201);
    const res = await http().post(`/api/v1/shifts/${shift.id}/open-drawer`).set(kasir).send({ reason: 'Tukar uang', pinApprovalId: approval.body.pinApprovalId }).expect(201);
    expect(res.body.movements.map((m: { kind: string }) => m.kind)).toEqual(['CASH_OUT', 'DRAWER_OPEN']);
  });

  it('closes the shift: journals the shortage, deposits to kas besar, leaves the float in the drawer', async () => {
    const shift = (await http().get('/api/v1/shifts/current').set(kasir)).body;
    await http().post(`/api/v1/shifts/${shift.id}/close`).set(kasir).send({ countedCash: 149000, depositAmount: 100000 }).expect(400);
    const res = await http()
      .post(`/api/v1/shifts/${shift.id}/close`)
      .set(kasir)
      .send({ countedCash: 149000, depositAmount: 100000, differenceReason: 'Kembalian salah hitung', cashDenominations: { '50000': 2, '20000': 2, '5000': 1, '2000': 2 } })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'CLOSED', expectedCash: 150000, countedCash: 149000, cashDifference: -1000, floatLeft: 49000, isForcedClose: false });
    expect(await balanceOf(drawerCode)).toBe(49000);
    expect(await balanceOf('6-3400')).toBe(1000);
    await http().post(`/api/v1/shifts/${shift.id}/close`).set(kasir).send({ countedCash: 0, depositAmount: 0 }).expect(400);
  });

  it('counts money left in the drawer toward the next float, and lets a supervisor force-close', async () => {
    const next = await http().post('/api/v1/shifts/open').set(kasir2).send({ id: crypto.randomUUID(), terminalId, openingFloat: 200000 }).expect(201);
    expect(next.body.drawerBalance).toBe(200000); // 49.000 left + 151.000 top-up
    const [top] = await testQuery<{ debit: number }>(
      `select l.debit::int from journals j join journal_lines l on l.journal_id = j.id join accounts a on a.id = l.account_id
       where j.source_doc_id = $1 and a.code = $2`,
      [next.body.id, drawerCode],
    );
    expect(top.debit).toBe(151000);
    await http().post(`/api/v1/shifts/${next.body.id}/close`).set(kasir).send({ countedCash: 200000, depositAmount: 0 }).expect(403);
    const forced = await http().post(`/api/v1/shifts/${next.body.id}/close`).set(owner).send({ countedCash: 200000, depositAmount: 200000 }).expect(201);
    expect(forced.body).toMatchObject({ isForcedClose: true, cashDifference: 0 });
    expect(await balanceOf(drawerCode)).toBe(0);
  });
});
