import './setup/env'; // precisa ser o primeiro import

import { readFileSync } from 'fs';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Tela de permissões em cards.
 *
 * O que não pode quebrar: salvar grava concessões e remoções de uma vez; quem
 * não é super só concede ou retira o que ele mesmo tem (o admin não se dá bots
 * nem base de cálculo); ninguém além do super mexe em perfil/usuário super nem
 * promove alguém a super; e a base de cálculo pede permissão própria.
 */
describe('Permissões em lote (e2e)', () => {
  let jwt: JwtService;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const api = () => request(httpServer());
  let requester = 1;
  const auth = (companyId: number, permissions: string[], profile = 'admin', sub = requester) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub, companyId, permissions, profile }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });

  const CATALOG: Array<[string, string]> = [
    ['update_profile', 'perfil'], ['list_profile', 'perfil'], ['update_user', 'user'], ['list_user', 'user'],
    ['view_clientes', 'clientes'], ['list_clientes', 'clientes'],
    ['usar_bots', 'bots'], ['update_integracoes', 'integracoes'],
    ['view_company', 'empresa'], ['update_company', 'empresa'],
    ['update_comercial', 'comercial'],
  ];

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    await db.permission.createMany({ data: CATALOG.map(([name, group]) => ({ name, group, description: `Desc ${name}` })) });
    const perms = Object.fromEntries((await db.permission.findMany()).map((p) => [p.name, p.id]));
    const superProfile = await db.profile.create({ data: { name: 'super', companyId: 0 } });
    const admin = await db.profile.create({ data: { name: 'admin', companyId: company.id } });
    const comercial = await db.profile.create({ data: { name: 'Comercial', companyId: company.id } });
    requester = (await makeSeller(company.id, { profileId: admin.id })).id;
    return { db, company, perms, superProfile, admin, comercial };
  }
  const ADMIN = ['update_profile', 'list_profile', 'update_user', 'list_user', 'view_clientes', 'list_clientes'];

  it('salva concessões e remoções de uma vez', async () => {
    const { db, company, perms, comercial } = await cenario();
    await db.profilePermission.create({ data: { profileId: comercial.id, permissionId: perms.list_user } });
    const h = auth(company.id, ADMIN);

    const { body } = await api().put(`/permissions/profile/${comercial.id}`).set(h)
      .send({ grant: [perms.view_clientes, perms.list_clientes], revoke: [perms.list_user] });

    expect(body).toEqual({ granted: 2, revoked: 1 });

    const active = await db.profilePermission.findMany({ where: { profileId: comercial.id, inactiveAt: null } });
    expect(active.map((row) => row.permissionId).sort()).toEqual([perms.view_clientes, perms.list_clientes].sort());

    // retirar de novo o que já saiu não quebra; reconceder reativa a linha
    await api().put(`/permissions/profile/${comercial.id}`).set(h).send({ revoke: [perms.list_user] }).expect(200);
    await api().put(`/permissions/profile/${comercial.id}`).set(h).send({ grant: [perms.list_user] }).expect(200);
    expect(await db.profilePermission.count({ where: { profileId: comercial.id, inactiveAt: null } })).toBe(3);

    // sem update_profile, nada
    await api().put(`/permissions/profile/${comercial.id}`).set(auth(company.id, ['list_profile'])).send({ grant: [perms.list_user] }).expect(403);
  });

  it('quem não é super só concede ou retira o que tem — e nada passa se um item for proibido', async () => {
    const { db, company, perms, comercial } = await cenario();
    const h = auth(company.id, ADMIN);

    const res = await api().put(`/permissions/profile/${comercial.id}`).set(h)
      .send({ grant: [perms.view_clientes, perms.usar_bots] }).expect(403);
    expect(res.body.message).toContain('Desc usar_bots');
    expect(await db.profilePermission.count({ where: { profileId: comercial.id } })).toBe(0);

    // as rotas antigas, de uma em uma, seguem a mesma regra
    await api().patch(`/permissions/profile/active/${comercial.id}/${perms.usar_bots}`).set(auth(company.id, [...ADMIN, 'activate_profile'])).expect(403);
    const user = await makeSeller(company.id, { profileId: comercial.id });
    await api().put(`/permissions/user/${user.id}`).set(h).send({ grant: [perms.update_integracoes] }).expect(403);
    await api().put(`/permissions/user/${user.id}`).set(h).send({ grant: [perms.view_clientes] }).expect(200);
    expect(await db.userPermission.count({ where: { userId: user.id, inactiveAt: null } })).toBe(1);
    await db.profilePermission.create({ data: { profileId: comercial.id, permissionId: perms.list_clientes } });
    const read = (await api().get(`/permissions/user/${user.id}`).set(h).expect(200)).body;
    expect(read).toMatchObject({ id: user.id, profileName: 'Comercial', granted: [perms.view_clientes], inherited: [perms.list_clientes] });
    expect((await api().get(`/permissions/profile/${comercial.id}`).set(h).expect(200)).body).toMatchObject({ name: 'Comercial', granted: [perms.list_clientes] });

    // o super concede qualquer uma
    await api().put(`/permissions/profile/${comercial.id}`).set(auth(company.id, ['update_profile'], 'super'))
      .send({ grant: [perms.usar_bots] }).expect(200);
  });

  it('ninguém além do super mexe no perfil super nem promove alguém a super', async () => {
    const { company, perms, superProfile, comercial } = await cenario();
    const h = auth(company.id, [...ADMIN, 'create_user']);
    const superUser = await makeSeller(company.id, { profileId: superProfile.id });
    const someone = await makeSeller(company.id, { profileId: comercial.id });

    await api().put(`/permissions/user/${superUser.id}`).set(h).send({ grant: [perms.view_clientes] }).expect(403);
    await api().put(`/user/${someone.id}`).set(h).send({ profileId: superProfile.id }).expect(403);
    await api().put(`/user/${superUser.id}`).set(h).send({ name: 'Outro nome' }).expect(403);
    await api().put(`/user/${someone.id}`).set(h).send({ name: 'Nome novo' }).expect(200);
    await api().put(`/profiles/${comercial.id}`).set(h).send({ name: 'Super' }).expect(400);

    // o super pode
    await api().put(`/user/${someone.id}`).set(auth(company.id, ['update_user'], 'super')).send({ profileId: superProfile.id }).expect(200);
  });

  it('base de cálculo pede permissão própria', async () => {
    const { company } = await cenario();
    await api().post('/commercial/tax-profiles').set(auth(company.id, ['list_comercial', 'create_comercial', 'update_comercial']))
      .send({ name: 'Simples' }).expect(403);
  });

  it('migração: admin ganha quase tudo; bots, integrações, dados da empresa e base de cálculo ficam com o super', async () => {
    const { db, perms, admin, superProfile } = await cenario();
    await db.profilePermission.create({ data: { profileId: admin.id, permissionId: perms.list_user } });
    const sql = readFileSync(join(__dirname, '../prisma/schema/migrations/20261208100000_permissoes_admin/migration.sql'), 'utf8');
    for (const statement of sql.split(/;\s*$/m).map((part) => part.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
    const names = async (profileId: number) => (await db.profilePermission.findMany({ where: { profileId, inactiveAt: null }, include: { permission: true } }))
      .map((row) => row.permission.name).sort();

    expect(await names(admin.id)).toEqual(['list_clientes', 'list_profile', 'list_user', 'update_comercial', 'update_profile', 'update_user', 'view_clientes', 'view_company']);
    expect(await names(superProfile.id)).toEqual(['update_base_calculo']);
  });
});
