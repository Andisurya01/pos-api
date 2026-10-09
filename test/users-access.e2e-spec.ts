import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PinService } from '../src/access/pin.service.js';
import { AccessService } from '../src/access/access.service.js';
import { AppModule } from '../src/app.module.js';
import { DB, type Database } from '../src/database/database.module.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

describe('Users, roles and supervisor PIN (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const roleIds: Record<string, string> = {};
  let ownerAuth: { Authorization: string };

  const login = async (username: string, password: string) => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ username, password })
      .expect(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  };

  const createUser = async (
    username: string,
    roles: string[],
    auth = ownerAuth,
  ) => {
    const res = await http()
      .post('/api/v1/users')
      .set(auth)
      .send({
        username,
        fullName: username.toUpperCase(),
        temporaryPassword: `${username}-temp-1`,
        roleIds: roles.map((r) => roleIds[r]),
      })
      .expect(201);
    return res.body.id as string;
  };

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
    ownerAuth = await login('owner', 'owner-pass-123');
    const roles = await http().get('/api/v1/access/roles').set(ownerAuth).expect(200);
    for (const r of roles.body) roleIds[r.name] = r.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('users', () => {
    it('creates a user who must change the temporary password', async () => {
      await createUser('kasir1', ['Kasir']);
      const list = await http().get('/api/v1/users').set(ownerAuth).expect(200);
      const kasir = list.body.find((u: { username: string }) => u.username === 'kasir1');
      expect(kasir).toMatchObject({
        mustChangePassword: true,
        isActive: true,
        hasPin: false,
        roles: [{ name: 'Kasir' }],
      });
      const kasirAuth = await login('kasir1', 'kasir1-temp-1');
      const me = await http()
        .get('/api/v1/auth/me')
        .set(kasirAuth)
        .expect(200);
      expect(me.body.mustChangePassword).toBe(true);
    });

    it('rejects a duplicate username regardless of case', async () => {
      await http()
        .post('/api/v1/users')
        .set(ownerAuth)
        .send({
          username: 'KASIR1',
          fullName: 'x',
          temporaryPassword: 'whatever-123',
          roleIds: [roleIds.Kasir],
        })
        .expect(409);
    });

    it('lets only an owner grant the Owner role', async () => {
      await createUser('admin1', ['Admin']);
      const adminAuth = await login('admin1', 'admin1-temp-1');
      await http()
        .post('/api/v1/users')
        .set(adminAuth)
        .send({
          username: 'sneaky',
          fullName: 'x',
          temporaryPassword: 'whatever-123',
          roleIds: [roleIds.Owner],
        })
        .expect(403);
      // An admin can still create normal users.
      await createUser('gudang1', ['Gudang'], adminAuth);
    });

    it('never leaves the store without an active owner', async () => {
      const [owner] = await testQuery<{ id: string }>(
        `select id from users where username = 'owner'`,
      );
      // Cannot deactivate yourself.
      await http()
        .post(`/api/v1/users/${owner.id}/deactivate`)
        .set(ownerAuth)
        .expect(400);
      // Cannot remove the Owner role from the only owner.
      await http()
        .put(`/api/v1/users/${owner.id}`)
        .set(ownerAuth)
        .send({ fullName: 'Pemilik', roleIds: [roleIds.Admin] })
        .expect(400);
      // With a second owner, the first one may be demoted.
      const owner2 = await createUser('owner2', ['Owner']);
      await http()
        .put(`/api/v1/users/${owner.id}`)
        .set(ownerAuth)
        .send({ fullName: 'Pemilik', roleIds: [roleIds.Owner, roleIds.Admin] })
        .expect(204);
      const owner2Auth = await login('owner2', 'owner2-temp-1');
      await http()
        .post(`/api/v1/users/${owner2}/deactivate`)
        .set(ownerAuth)
        .expect(204);
      await http().get('/api/v1/auth/me').set(owner2Auth).expect(401);
    });

    it('deactivating a user ends their sessions; reset-password clears a lockout', async () => {
      const id = await createUser('kasir2', ['Kasir']);
      const auth = await login('kasir2', 'kasir2-temp-1');
      await http().post(`/api/v1/users/${id}/deactivate`).set(ownerAuth).expect(204);
      await http().get('/api/v1/auth/me').set(auth).expect(401);
      await http().post(`/api/v1/users/${id}/activate`).set(ownerAuth).expect(204);

      for (let i = 0; i < 5; i++) {
        await http().post('/api/v1/auth/login').send({ username: 'kasir2', password: 'x' });
      }
      await http()
        .post('/api/v1/auth/login')
        .send({ username: 'kasir2', password: 'kasir2-temp-1' })
        .expect(423);
      await http()
        .post(`/api/v1/users/${id}/reset-password`)
        .set(ownerAuth)
        .send({ temporaryPassword: 'kasir2-new-123' })
        .expect(204);
      await login('kasir2', 'kasir2-new-123');
    });
  });

  describe('roles', () => {
    it('creates a custom role, edits its ticks with an audit trail, and deletes it', async () => {
      const created = await http()
        .post('/api/v1/access/roles')
        .set(ownerAuth)
        .send({
          name: 'Supervisor',
          description: 'Kepala kasir',
          permissions: ['penjualan.transaksi.void', 'penjualan.kasir.lihat'],
        })
        .expect(201);
      await http()
        .post('/api/v1/access/roles')
        .set(ownerAuth)
        .send({ name: 'supervisor', permissions: [] })
        .expect(409);
      await http()
        .put(`/api/v1/access/roles/${created.body.id}`)
        .set(ownerAuth)
        .send({ name: 'Supervisor', permissions: ['penjualan.transaksi.void'] })
        .expect(200);
      const audit = await testQuery<{ before: { permissions: string[] }; after: { permissions: string[] } }>(
        `select before, after from audit_logs where action = 'permission.change' and entity_id = $1`,
        [created.body.id],
      );
      expect(audit[0].before.permissions).toEqual([
        'penjualan.kasir.lihat',
        'penjualan.transaksi.void',
      ]);
      expect(audit[0].after.permissions).toEqual(['penjualan.transaksi.void']);
      await http()
        .delete(`/api/v1/access/roles/${created.body.id}`)
        .set(ownerAuth)
        .expect(204);
    });

    it('rejects unknown permission codes, editing the Owner role, and deleting built-in roles', async () => {
      const bad = await http()
        .post('/api/v1/access/roles')
        .set(ownerAuth)
        .send({ name: 'X', permissions: ['penjualan.semua.boleh'] })
        .expect(400);
      expect(bad.body.issues[0].path).toBe('permissions.0');
      await http()
        .put(`/api/v1/access/roles/${roleIds.Owner}`)
        .set(ownerAuth)
        .send({ name: 'Owner', permissions: [] })
        .expect(400);
      await http()
        .delete(`/api/v1/access/roles/${roleIds.Kasir}`)
        .set(ownerAuth)
        .expect(400);
    });

    it('refuses to delete a role that an active user still holds', async () => {
      const role = await http()
        .post('/api/v1/access/roles')
        .set(ownerAuth)
        .send({ name: 'Pramuniaga', permissions: ['produk.produk.lihat'] })
        .expect(201);
      await createUser('prami', ['Kasir']);
      const [prami] = await testQuery<{ id: string }>(`select id from users where username = 'prami'`);
      await http()
        .put(`/api/v1/users/${prami.id}`)
        .set(ownerAuth)
        .send({ fullName: 'Prami', roleIds: [role.body.id] })
        .expect(204);
      await http().delete(`/api/v1/access/roles/${role.body.id}`).set(ownerAuth).expect(409);
    });
  });

  describe('supervisor PIN', () => {
    let kasirAuth: { Authorization: string };

    beforeAll(async () => {
      await createUser('spv', ['Admin']);
      const spvAuth = await login('spv', 'spv-temp-1');
      await http()
        .put('/api/v1/users/me/pin')
        .set(spvAuth)
        .send({ pin: '246810' })
        .expect(204);
      await createUser('kasir3', ['Kasir']);
      kasirAuth = await login('kasir3', 'kasir3-temp-1');
    });

    const approve = (pin: string, approverId: string, code = 'penjualan.transaksi.void') =>
      http()
        .post('/api/v1/access/pin-approvals')
        .set(kasirAuth)
        .send({ permissionCode: code, approverId, pin, details: { saleNo: 'PJ/2610/00001' } });

    it('lists only users with a PIN who hold the permission', async () => {
      const res = await http()
        .get('/api/v1/access/pin-approvers?permission=penjualan.transaksi.void')
        .set(kasirAuth)
        .expect(200);
      expect(res.body.map((u: { fullName: string }) => u.fullName)).toEqual(['SPV']);
    });

    it('approves with the right PIN and the approval can be consumed exactly once', async () => {
      const [spv] = await testQuery<{ id: string }>(`select id from users where username = 'spv'`);
      const ok = await approve('246810', spv.id).expect(201);
      expect(ok.body.approvedBy).toBe('SPV');

      const pins = app.get(PinService);
      const access = app.get(AccessService);
      const db = app.get<Database>(DB);
      const [kasir] = await testQuery<{ id: string }>(`select id from users where username = 'kasir3'`);
      const grants = await access.grantsOfUser(kasir.id);
      const principal = {
        userId: kasir.id,
        sessionId: '00000000-0000-0000-0000-000000000000',
        terminalId: null,
        username: 'kasir3',
        fullName: 'KASIR3',
        mustChangePassword: false,
        ...grants,
      };
      const entity = { type: 'sale_void', id: crypto.randomUUID() };
      const used = await db.transaction((tx) =>
        pins.authorize(tx, principal, 'penjualan.transaksi.void', ok.body.pinApprovalId, entity),
      );
      expect(used).toBe(ok.body.pinApprovalId);
      await expect(
        db.transaction((tx) =>
          pins.authorize(tx, principal, 'penjualan.transaksi.void', ok.body.pinApprovalId, entity),
        ),
      ).rejects.toThrow('Persetujuan PIN tidak berlaku');
      // Wrong action for the approval, or no approval at all.
      await expect(
        db.transaction((tx) =>
          pins.authorize(tx, principal, 'penjualan.kasir.ubah_harga', null, entity),
        ),
      ).rejects.toThrow('membutuhkan PIN supervisor');
    });

    it('rejects approvers without the permission and actions that do not use PINs', async () => {
      const [kasir1] = await testQuery<{ id: string }>(`select id from users where username = 'kasir1'`);
      const kasir1Auth = await login('kasir1', 'kasir1-temp-1');
      await http()
        .put('/api/v1/users/me/pin')
        .set(kasir1Auth)
        .send({ pin: '111111' })
        .expect(204);
      await approve('111111', kasir1.id).expect(403);
      const [spv] = await testQuery<{ id: string }>(`select id from users where username = 'spv'`);
      await approve('246810', spv.id, 'produk.produk.ubah').expect(400);
    });

    it('locks the PIN after 3 wrong attempts', async () => {
      const [spv] = await testQuery<{ id: string }>(`select id from users where username = 'spv'`);
      await approve('000000', spv.id).expect(401);
      await approve('000001', spv.id).expect(401);
      await approve('000002', spv.id).expect(423);
      await approve('246810', spv.id).expect(423);
    });
  });
});
