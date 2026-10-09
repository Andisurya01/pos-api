import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { businessDate, docMonth } from '../src/common/business-date.js';
import { DB, type Database } from '../src/database/database.module.js';
import { JournalService } from '../src/finance/journal.service.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Finance operations: cash, manual journals, settlement, period close (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const today = businessDate();
  const yymm = docMonth(today);
  const period = today.slice(0, 7);
  let owner: { Authorization: string };
  let keuangan: { Authorization: string };
  let staf: { Authorization: string };
  const acc: Record<string, string> = {};
  let listrik: string;

  const login = async (username: string, password: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };
  const addUser = async (username: string, role: string) => {
    const [u] = await testQuery<{ id: string }>(`insert into users (username, full_name, password_hash) values ($1, $1, $2) returning id`, [username, await hash(`${username}-pass-1`)]);
    await testQuery(`insert into user_roles (user_id, role_id) select $1, id from roles where name = $2`, [u.id, role]);
    return login(username, `${username}-pass-1`);
  };
  const balanceOf = async (code: string) =>
    (await testQuery<{ v: number }>(`select coalesce(sum(l.debit - l.credit), 0)::bigint::int as v from journal_lines l join accounts a on a.id = l.account_id where a.code = $1`, [code]))[0].v;
  const autoJournal = (journalNo: string, journalDate: string, lines: Parameters<JournalService['post']>[2]['lines']) =>
    app.get<Database>(DB).transaction((tx) => app.get(JournalService).post(tx, { userId: acc.ownerId }, { journalNo, journalDate, source: 'AUTO', description: 'test', lines }));

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await http().post('/api/v1/setup/owner').send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' }).expect(201);
    owner = await login('owner', 'owner-pass-123');
    keuangan = await addUser('keu', 'Keuangan');
    await http().post('/api/v1/access/roles').set(owner).send({ name: 'Staf Kas', permissions: ['keuangan.pengeluaran.buat', 'keuangan.pengeluaran.lihat'] }).expect(201);
    staf = await addUser('staf', 'Staf Kas');
    for (const r of await testQuery<{ id: string; code: string }>(`select id, code from accounts`)) acc[r.code] = r.id;
    acc.ownerId = (await testQuery<{ id: string }>(`select id from users where username = 'owner'`))[0].id;
    acc.bank = (await http().post('/api/v1/accounts').set(owner).send({ code: '1-1210', name: 'Bank BCA', parentId: acc['1-1200'], cashKind: 'BANK' }).expect(201)).body.id;
    const cats = (await http().get('/api/v1/finance-categories').set(keuangan).expect(200)).body;
    expect(cats).toHaveLength(11);
    listrik = cats.find((c: { name: string }) => c.name === 'Listrik').id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('posts a manual journal only after someone else approves it, never on control accounts', async () => {
    const id = crypto.randomUUID();
    const draft = { id, journalDate: today, description: 'Setoran modal pemilik', lines: [{ accountId: acc['1-1100'], debit: 5000000 }, { accountId: acc['3-1000'], credit: 5000000 }] };
    await http().put('/api/v1/manual-journals').set(owner).send(draft).expect(200);
    await http().post(`/api/v1/manual-journals/${id}/submit`).set(owner).expect(201);
    await http().post(`/api/v1/manual-journals/${id}/approve`).set(owner).expect(403);
    const posted = await http().post(`/api/v1/manual-journals/${id}/approve`).set(keuangan).expect(201);
    expect(posted.body).toMatchObject({ status: 'POSTED', docNo: `JU/${yymm}/00001` });
    expect(await balanceOf('1-1100')).toBe(5000000);

    const bad = await http().put('/api/v1/manual-journals').set(owner).send({ ...draft, id: crypto.randomUUID(), lines: [{ accountId: acc['1-1400'], debit: 1 }, { accountId: acc['3-1000'], credit: 1 }] }).expect(400);
    expect(bad.body.message).toContain('1-1400');
  });

  it('holds a kas keluar for approval when the creator may not approve', async () => {
    const id = crypto.randomUUID();
    const res = await http().post('/api/v1/cash-transactions').set(staf).send({ id, direction: 'OUT', categoryId: listrik, cashAccountId: acc['1-1100'], amount: 150000, description: 'Token listrik' }).expect(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(await balanceOf('6-1100')).toBe(0);
    const ok = await http().post(`/api/v1/cash-transactions/${id}/approve`).set(keuangan).expect(201);
    expect(ok.body).toMatchObject({ status: 'POSTED', docNo: `KK/${yymm}/00001` });
    expect(await balanceOf('6-1100')).toBe(150000);
    await http().post('/api/v1/cash-transactions').set(keuangan).send({ id: crypto.randomUUID(), direction: 'OUT', categoryId: listrik, cashAccountId: acc['1-1100'], amount: 99000000, description: 'Terlalu besar' }).expect(400);
  });

  it('moves money from kas besar to the bank', async () => {
    const res = await http().post('/api/v1/cash-transfers').set(keuangan).send({ id: crypto.randomUUID(), fromAccountId: acc['1-1100'], toAccountId: acc.bank, amount: 2000000 }).expect(201);
    expect(res.body.docNo).toMatch(/^MK\//);
    expect(await balanceOf('1-1210')).toBe(2000000);
    expect(await balanceOf('1-1100')).toBe(2850000);
  });

  it('settles QRIS receipts into the bank, booking the MDR', async () => {
    await autoJournal('PJ-QRIS-1', today, [{ account: { accountId: acc['1-1310'] }, debit: 100000 }, { account: 'SALES', credit: 100000 }]);
    const [qris] = await testQuery<{ id: string }>(`select id from payment_methods where code = 'QRIS'`);
    await http().post('/api/v1/edc-settlements').set(keuangan).send({ id: crypto.randomUUID(), paymentMethodId: qris.id, bankAccountId: acc.bank, grossAmount: 200000, mdrAmount: 1400 }).expect(400);
    const res = await http().post('/api/v1/edc-settlements').set(keuangan).send({ id: crypto.randomUUID(), paymentMethodId: qris.id, bankAccountId: acc.bank, grossAmount: 100000, mdrAmount: 700 }).expect(201);
    expect(res.body).toMatchObject({ netAmount: 99300 });
    expect(await balanceOf('1-1310')).toBe(0);
    expect(await balanceOf('6-3100')).toBe(700);
  });

  it('closes a month, refuses postings into it, and only the owner reopens it', async () => {
    const pendingId = crypto.randomUUID();
    await http().post('/api/v1/cash-transactions').set(staf).send({ id: pendingId, direction: 'OUT', categoryId: listrik, cashAccountId: acc['1-1100'], amount: 1000, description: 'Masih menunggu' }).expect(201);
    const blocked = await http().post(`/api/v1/periods/${period}/close`).set(keuangan).expect(400);
    expect(blocked.body.checks.map((c: { code: string }) => c.code)).toEqual(['NOTHING_PENDING']);
    await http().post(`/api/v1/cash-transactions/${pendingId}/cancel`).set(keuangan).expect(201);

    const closed = await http().post(`/api/v1/periods/${period}/close`).set(keuangan).expect(201);
    expect(closed.body.status).toBe('CLOSED');
    await http().post('/api/v1/cash-transactions').set(keuangan).send({ id: crypto.randomUUID(), direction: 'OUT', categoryId: listrik, cashAccountId: acc['1-1100'], amount: 1000, description: 'Telat' }).expect(400);
    await http().post(`/api/v1/periods/${period}/reopen`).set(keuangan).send({ reason: 'Koreksi' }).expect(403);
  });

  it('closes the year: revenue and expenses move to laba ditahan, reopening undoes it', async () => {
    const year = today.slice(0, 4);
    await autoJournal('DES-1', `${year}-12-15`, [{ account: 'MAIN_CASH', debit: 300000 }, { account: 'SALES', credit: 300000 }]);
    const closed = await http().post(`/api/v1/periods/${year}-12/close`).set(keuangan).expect(201);
    expect(closed.body.closingJournalId).toBeTruthy();
    // Year profit: sales 100.000 + 300.000 − listrik 150.000 − MDR 700 = 249.300.
    expect(await balanceOf('3-2000')).toBe(-249300);
    expect(await balanceOf('4-1000')).toBe(0);
    expect(await balanceOf('6-1100')).toBe(0);

    await http().post(`/api/v1/periods/${period}/reopen`).set(owner).send({ reason: 'Koreksi stok' }).expect(201);
    const periods = await testQuery<{ id: string; status: string }>(`select id, status from periods order by id`);
    expect(periods.every((p) => p.status === 'OPEN')).toBe(true);
    expect(await balanceOf('3-2000')).toBe(0);
    expect(await balanceOf('4-1000')).toBe(-400000);
  });
});
