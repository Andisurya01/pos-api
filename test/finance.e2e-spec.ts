import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { DB, type Database } from '../src/database/database.module.js';
import { DocumentNumberService } from '../src/finance/document-number.service.js';
import { JournalService } from '../src/finance/journal.service.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Finance core: accounts, numbering, journals (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let journalsSvc: JournalService;
  let numbers: DocumentNumberService;
  let owner: { Authorization: string };
  let actor: { userId: string };
  const http = () => request(app.getHttpServer());

  /** A typical cash sale: Rp47.400 (DPP 43.882 + PPN 3.468 + pembulatan 50), docs/alur/04. */
  const saleLines = () => [
    { account: 'MAIN_CASH' as const, debit: 47400 },
    { account: 'SALES' as const, credit: 43882 },
    { account: 'VAT_OUT' as const, credit: 3468 },
    { account: 'ROUNDING_GAIN' as const, credit: 50 },
  ];

  const post = (journalNo: string, journalDate = '2026-10-09', lines = saleLines(), source: 'AUTO' | 'MANUAL' = 'AUTO') =>
    db.transaction((tx) =>
      journalsSvc.post(tx, actor, { journalNo, journalDate, source, description: 'Penjualan', lines }),
    );

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    db = app.get<Database>(DB);
    journalsSvc = app.get(JournalService);
    numbers = app.get(DocumentNumberService);

    await http()
      .post('/api/v1/setup/owner')
      .send({ username: 'owner', fullName: 'Pemilik', password: 'owner-pass-123' })
      .expect(201);
    const res = await http().post('/api/v1/auth/login').send({ username: 'owner', password: 'owner-pass-123' });
    owner = { Authorization: `Bearer ${res.body.accessToken}` };
    const [u] = await testQuery<{ id: string }>(`select id from users where username = 'owner'`);
    actor = { userId: u.id };
  });

  afterAll(async () => {
    await app.close();
  });

  it('installs the chart of accounts with every mapping filled', async () => {
    const accounts = await http().get('/api/v1/accounts').set(owner).expect(200);
    expect(accounts.body.length).toBeGreaterThan(50);
    const inventory = accounts.body.find((a: { code: string }) => a.code === '1-1400');
    expect(inventory).toMatchObject({ isControl: true, mappedAs: ['INVENTORY'], normalBalance: 'DEBIT' });
    const mappings = await http().get('/api/v1/account-mappings').set(owner).expect(200);
    expect(mappings.body).toHaveLength(25);
  });

  it('posts a balanced journal and shows it with its lines', async () => {
    const journal = await post('PJ/2610/00001');
    const detail = await http().get(`/api/v1/journals/${journal.id}`).set(owner).expect(200);
    expect(detail.body.lines.map((l: { accountCode: string; debit: number; credit: number }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1-1100', 47400, 0],
      ['4-1000', 0, 43882],
      ['2-1300', 0, 3468],
      ['4-2100', 0, 50],
    ]);
    const list = await http().get('/api/v1/journals?from=2026-10-01&to=2026-10-31').set(owner).expect(200);
    expect(list.body.data[0]).toMatchObject({ journalNo: 'PJ/2610/00001', total: 47400 });
    const periods = await http().get('/api/v1/periods').set(owner).expect(200);
    expect(periods.body[0]).toMatchObject({ id: '2026-10', status: 'OPEN', startsOn: '2026-10-01', endsOn: '2026-10-31' });
  });

  it('rejects unbalanced or malformed journals in the service', async () => {
    const lines = saleLines();
    lines[3] = { account: 'ROUNDING_GAIN', credit: 49 };
    await expect(post('X-1', '2026-10-09', lines)).rejects.toThrow('tidak seimbang');
    await expect(
      post('X-2', '2026-10-09', [{ account: 'MAIN_CASH', debit: 100, credit: 100 } as never, { account: 'SALES', credit: 0 }]),
    ).rejects.toThrow('debit atau kredit');
  });

  it('keeps manual journals away from control accounts', async () => {
    await expect(
      post('JU-1', '2026-10-09', [
        { account: 'INVENTORY', debit: 1000 },
        { account: 'MAIN_CASH', credit: 1000 },
      ], 'MANUAL'),
    ).rejects.toThrow('hanya bisa diubah lewat dokumen');
  });

  describe('database guards (even if application code were wrong)', () => {
    const rawJournal = async () => {
      const [j] = await testQuery<{ id: string }>(
        `insert into journals (journal_no, journal_date, period_id, source, description, status)
         values ($1, '2026-10-09', '2026-10', 'AUTO', 'raw', 'POSTED') returning id`,
        [`RAW-${Math.random()}`],
      );
      return j.id;
    };

    it('refuses to commit an unbalanced journal', async () => {
      const [cash] = await testQuery<{ id: string }>(`select id from accounts where code = '1-1100'`);
      const [sales] = await testQuery<{ id: string }>(`select id from accounts where code = '4-1000'`);
      await expect(
        testQuery(
          `with j as (
             insert into journals (journal_no, journal_date, period_id, source, description, status)
             values ('RAW-UNBAL', '2026-10-09', '2026-10', 'AUTO', 'raw', 'POSTED') returning id)
           insert into journal_lines (journal_id, account_id, debit, credit, journal_date)
           select id, $1::uuid, 1000, 0, date '2026-10-09' from j
           union all select id, $2::uuid, 0, 999, date '2026-10-09' from j`,
          [cash.id, sales.id],
        ),
      ).rejects.toThrow('not balanced');
      await expect(rawJournal()).rejects.toThrow('not balanced');
    });

    it('refuses to change or delete posted journals and their lines', async () => {
      await expect(testQuery(`update journals set description = 'diubah' where journal_no = 'PJ/2610/00001'`)).rejects.toThrow('cannot be changed');
      await expect(testQuery(`delete from journal_lines`)).rejects.toThrow('append-only');
      await expect(testQuery(`update journal_lines set debit = debit + 1`)).rejects.toThrow('append-only');
    });
  });

  it('reverses a journal with a mirror image, once', async () => {
    const original = await post('PJ/2610/00002');
    const reversal = await db.transaction((tx) =>
      journalsSvc.reverse(tx, actor, original.id, { journalNo: 'VD/2610/00001', journalDate: '2026-10-09', description: 'Void' }),
    );
    const detail = await http().get(`/api/v1/journals/${reversal.id}`).set(owner).expect(200);
    expect(detail.body.reversalOfId).toBe(original.id);
    expect(detail.body.lines[0]).toMatchObject({ accountCode: '1-1100', debit: 0, credit: 47400 });
    await expect(
      db.transaction((tx) =>
        journalsSvc.reverse(tx, actor, original.id, { journalNo: 'VD/2610/00002', journalDate: '2026-10-09', description: 'Void lagi' }),
      ),
    ).rejects.toThrow('sudah pernah dibalik');
  });

  it('blocks postings into a closed period, in the service and in the database', async () => {
    await post('PJ/2609/00001', '2026-09-30');
    await testQuery(`update periods set status = 'CLOSED' where id = '2026-09'`);
    await expect(post('PJ/2609/00002', '2026-09-30')).rejects.toThrow('sudah ditutup');
    const [cash] = await testQuery<{ id: string }>(`select id from accounts where code = '1-1100'`);
    const [j] = await testQuery<{ id: string }>(`select id from journals where journal_no = 'PJ/2609/00001'`);
    await expect(
      testQuery(`insert into journal_lines (journal_id, account_id, debit, credit, journal_date) values ($1, $2, 1, 0, '2026-09-30')`, [j.id, cash.id]),
    ).rejects.toThrow('closed');
  });

  describe('document numbers', () => {
    it('restart every month and give the number back when a posting rolls back', async () => {
      const take = (date: string) => db.transaction((tx) => numbers.next(tx, 'PO', date));
      expect(await take('2026-10-09')).toBe('PO/2610/00001');
      await expect(
        db.transaction(async (tx) => {
          await numbers.next(tx, 'PO', '2026-10-09');
          throw new Error('posting failed');
        }),
      ).rejects.toThrow('posting failed');
      expect(await take('2026-10-31')).toBe('PO/2610/00002');
      expect(await take('2026-11-01')).toBe('PO/2611/00001');
    });

    it('never hands out the same number to concurrent postings', async () => {
      const results = await Promise.all(
        Array.from({ length: 15 }, () => db.transaction((tx) => numbers.next(tx, 'PB', '2026-10-09'))),
      );
      expect(new Set(results).size).toBe(15);
      expect(results.sort()).toEqual(
        Array.from({ length: 15 }, (_, i) => `PB/2610/${String(i + 1).padStart(5, '0')}`),
      );
    });
  });

  it('protects mapped accounts and only maps postable ones', async () => {
    const accounts = await http().get('/api/v1/accounts').set(owner).expect(200);
    const find = (code: string) => accounts.body.find((a: { code: string }) => a.code === code);
    await http()
      .put(`/api/v1/accounts/${find('1-1400').id}`)
      .set(owner)
      .send({ name: 'Persediaan', isActive: false })
      .expect(409);
    await http()
      .put('/api/v1/account-mappings/MAIN_CASH')
      .set(owner)
      .send({ accountId: find('1-1000').id })
      .expect(400);
    const bank = await http()
      .post('/api/v1/accounts')
      .set(owner)
      .send({ code: '1-1210', name: 'Bank BCA 123', parentId: find('1-1200').id, cashKind: 'BANK' })
      .expect(201);
    expect(bank.body).toMatchObject({ type: 'ASSET', normalBalance: 'DEBIT', isControl: false });
    await http()
      .post('/api/v1/accounts')
      .set(owner)
      .send({ code: '1-1211', name: 'Salah induk', parentId: find('1-1100').id })
      .expect(400);
  });
});
