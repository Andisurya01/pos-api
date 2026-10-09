import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PERMISSION_CODES } from '../src/access/permission-registry.js';
import { AppModule } from '../src/app.module.js';
import { resetTestDatabase, testQuery } from './helpers/db.js';

const OWNER = { username: 'owner', fullName: 'Pemilik Toko', password: 'owner-pass-123' };

async function createUserWithRole(username: string, password: string, role: string) {
  const [user] = await testQuery<{ id: string }>(
    `insert into users (username, full_name, password_hash) values ($1, $1, $2) returning id`,
    [username, await hash(password)],
  );
  await testQuery(
    `insert into user_roles (user_id, role_id) select $1, id from roles where name = $2`,
    [user.id, role],
  );
  return user.id;
}

describe('Auth and access (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await resetTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init(); // seeds permissions and built-in roles
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (username: string, password: string) =>
    http().post('/api/v1/auth/login').send({ username, password });

  it('seeds every registered permission and the five built-in roles', async () => {
    const perms = await testQuery<{ n: number }>('select count(*)::int as n from permissions');
    expect(perms[0].n).toBe(PERMISSION_CODES.length);
    const roles = await testQuery<{ name: string }>('select name from roles order by name');
    expect(roles.map((r) => r.name)).toEqual(['Admin', 'Gudang', 'Kasir', 'Keuangan', 'Owner']);
  });

  it('rejects protected routes without a token, but serves public ones', async () => {
    await http().get('/api/v1/auth/me').expect(401);
    await http().get('/api/v1/health').expect(200);
  });

  it('creates the first owner once, then locks the wizard', async () => {
    await http().get('/api/v1/setup/status').expect(200, { needsOwner: true });
    await http().post('/api/v1/setup/owner').send(OWNER).expect(201);
    await http().post('/api/v1/setup/owner').send(OWNER).expect(409);
    await http().get('/api/v1/setup/status').expect(200, { needsOwner: false });
  });

  it('validates the wizard input', async () => {
    const res = await http()
      .post('/api/v1/setup/owner')
      .send({ username: 'x', fullName: '', password: 'short' })
      .expect(400);
    expect(res.body.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'fullName',
      'password',
      'username',
    ]);
  });

  it('logs the owner in (username is case-insensitive) with every permission', async () => {
    const res = await login('OWNER', OWNER.password).expect(200);
    const me = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.isOwner).toBe(true);
    expect(me.body.roles).toEqual(['Owner']);
    expect(me.body.permissions).toHaveLength(PERMISSION_CODES.length);
  });

  it('rejects a wrong password with the same message as an unknown user', async () => {
    const wrong = await login('owner', 'wrong-password').expect(401);
    const unknown = await login('nobody', 'wrong-password').expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('enforces permissions: a cashier cannot open the access matrix, the owner can', async () => {
    await createUserWithRole('kasir1', 'kasir-pass-1', 'Kasir');
    const kasir = await login('kasir1', 'kasir-pass-1').expect(200);
    const denied = await http()
      .get('/api/v1/access/roles')
      .set('Authorization', `Bearer ${kasir.body.accessToken}`)
      .expect(403);
    expect(denied.body.missingPermissions).toEqual(['pengaturan.hak_akses.lihat']);

    const owner = await login('owner', OWNER.password).expect(200);
    const roles = await http()
      .get('/api/v1/access/roles')
      .set('Authorization', `Bearer ${owner.body.accessToken}`)
      .expect(200);
    const kasirRole = roles.body.find((r: { name: string }) => r.name === 'Kasir');
    expect(kasirRole.permissions).not.toContain('penjualan.kasir.diskon_manual');

    const tree = await http()
      .get('/api/v1/access/permissions')
      .set('Authorization', `Bearer ${owner.body.accessToken}`)
      .expect(200);
    expect(tree.body[0]).toMatchObject({ module: 'pengaturan', label: 'Pengaturan' });
  });

  it('applies permission changes immediately, without logging in again', async () => {
    await createUserWithRole('gudang1', 'gudang-pass-1', 'Gudang');
    const gudang = await login('gudang1', 'gudang-pass-1').expect(200);
    const auth = { Authorization: `Bearer ${gudang.body.accessToken}` };
    await http().get('/api/v1/access/roles').set(auth).expect(403);
    await testQuery(
      `insert into role_permissions (role_id, permission_code)
       select id, 'pengaturan.hak_akses.lihat' from roles where name = 'Gudang'`,
    );
    await http().get('/api/v1/access/roles').set(auth).expect(200);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const first = await login('owner', OWNER.password).expect(200);
    const second = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);

    // Replaying the old token = possible theft: the whole session ends.
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(401);
  });

  it('logout ends the session immediately, even though the access token has not expired', async () => {
    const res = await login('owner', OWNER.password).expect(200);
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    await http().post('/api/v1/auth/logout').set(auth).expect(204);
    await http().get('/api/v1/auth/me').set(auth).expect(401);
  });

  it('changes the password and ends the other sessions', async () => {
    await createUserWithRole('admin1', 'admin-pass-1', 'Admin');
    const other = await login('admin1', 'admin-pass-1').expect(200);
    const current = await login('admin1', 'admin-pass-1').expect(200);
    await http()
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${current.body.accessToken}`)
      .send({ currentPassword: 'admin-pass-1', newPassword: 'admin-pass-2' })
      .expect(204);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${current.body.accessToken}`)
      .expect(200);
    await login('admin1', 'admin-pass-1').expect(401);
    await login('admin1', 'admin-pass-2').expect(200);
  });

  it('locks the account after 5 failed attempts, even for the right password', async () => {
    await createUserWithRole('kasir2', 'kasir-pass-2', 'Kasir');
    for (let i = 0; i < 4; i++) await login('kasir2', 'wrong').expect(401);
    await login('kasir2', 'wrong').expect(423);
    await login('kasir2', 'kasir-pass-2').expect(423);
    const actions = await testQuery<{ action: string }>(
      `select action from audit_logs a join users u on u.id = a.user_id
       where u.username = 'kasir2' order by a.id`,
    );
    expect(actions.map((a) => a.action)).toEqual([
      ...Array(4).fill('login.failed'),
      'login.locked',
    ]);
  });

  it('refuses login for a deactivated user', async () => {
    await createUserWithRole('mantan', 'mantan-pass-1', 'Kasir');
    await testQuery(`update users set is_active = false where username = 'mantan'`);
    await login('mantan', 'mantan-pass-1').expect(401);
  });
});
