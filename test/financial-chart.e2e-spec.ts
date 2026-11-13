import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeGateway, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano de contas (conta mãe/filha), centros de custo, contas bancárias e a
 * classificação dos recebíveis.
 *
 * As regras que importam aqui são as que o sistema de referência deixava só
 * na tela: lançamento nunca cai em conta mãe, código é sempre derivado, e
 * nada disso pode atrapalhar o checkout.
 */
describe('Financeiro — plano de contas, centros de custo e contas bancárias (e2e)', () => {
  const ALL = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro', 'activate_financeiro'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const customer = await db.customer.create({ data: {
      name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'financeiro@alfa.local', stateId: state.id, cityId: city.id,
    } });
    return { db, company, customer };
  }

  type Row = { id: number; code: string; name: string; level: number; nature: string; parentId: number | null;
    acceptsEntries: boolean; isSystem: boolean; children: number; entries: number; total: number; inactiveAt: string | null };
  async function tree(companyId: number, query: Record<string, string> = {}): Promise<Row[]> {
    return (await api().get('/financial/chart-accounts').query(query).set(auth(companyId)).expect(200)).body;
  }
  const byCode = (rows: Row[], code: string) => rows.find((r) => r.code === code)!;
  const novaConta = (companyId: number, parentId: number, name: string) =>
    api().post('/financial/chart-accounts').set(auth(companyId)).send({ parentId, name });
  const lancar = (companyId: number, customerId: number, extra: Record<string, any> = {}) =>
    api().post('/financial-records').set(auth(companyId))
      .send({ customerId, value: 1000, dueDate: '2026-12-10', paymentMethod: 'transferencia', ...extra });

  describe('plano padrão', () => {
    it('cria raízes, grupos, centros de custo e a classificação de inscrição na primeira abertura', async () => {
      const { db, company } = await cenario();
      const rows = await tree(company.id);

      expect(rows.map((r) => r.code).slice(0, 5)).toEqual(['1', '1.1', '1.1.1', '1.1.2', '1.2']);
      expect(byCode(rows, '1')).toMatchObject({ name: 'Receitas', nature: 'receita', level: 1, isSystem: true, acceptsEntries: false });
      expect(byCode(rows, '2')).toMatchObject({ name: 'Despesas', nature: 'despesa', isSystem: true });
      expect(byCode(rows, '1.1')).toMatchObject({ name: 'Treinamentos', level: 2, acceptsEntries: false, children: 2 });
      expect(byCode(rows, '1.1.1')).toMatchObject({ level: 3, acceptsEntries: true, nature: 'receita' });
      // grupo de despesa ainda sem filhas aceita lançamento (não fica inutilizável)
      expect(byCode(rows, '2.1')).toMatchObject({ name: 'Pessoal', acceptsEntries: true, nature: 'despesa' });

      expect((await db.financial_CostCenter.findMany({ orderBy: { id: 'asc' } })).map((c) => c.name))
        .toEqual(['Treinamentos', 'Serviços', 'Loja', 'Administrativo']);
      const padrao = await db.financial_ClassificationDefault.findFirst({ where: { origin: 'inscricao' }, include: { chartAccount: true, costCenter: true } });
      expect(padrao.chartAccount.code).toBe('1.1.1');
      expect(padrao.costCenter.name).toBe('Treinamentos');
    });

    it('é idempotente, inclusive com duas aberturas ao mesmo tempo', async () => {
      const { db, company } = await cenario();
      await Promise.all([tree(company.id), tree(company.id), tree(company.id)]);
      await tree(company.id);
      expect(await db.financial_ChartAccount.count({ where: { isSystem: true } })).toBe(2);
      expect(await db.financial_CostCenter.count()).toBe(4);
    });

    it('cada empresa tem o seu plano', async () => {
      const { company } = await cenario();
      const outra = await makeCompany();
      const a = await tree(company.id);
      const b = await tree(outra.id);
      expect(byCode(a, '1').id).not.toBe(byCode(b, '1').id);
      await novaConta(outra.id, byCode(a, '1.1').id, 'Invasora').expect(404);
    });
  });

  describe('criar conta filha', () => {
    it('gera o código, herda natureza e nível, e não reaproveita número', async () => {
      const { company } = await cenario();
      const rows = await tree(company.id);
      const grupo = byCode(rows, '1.1');

      const nova = (await novaConta(company.id, grupo.id, '  EAD   avulso ').expect(201)).body;
      expect(nova).toMatchObject({ code: '1.1.3', name: 'EAD avulso', level: 3, nature: 'receita', parentId: grupo.id, acceptsEntries: true });

      await api().patch(`/financial/chart-accounts/inactive/${nova.id}`).set(auth(company.id)).expect(200);
      const outra = (await novaConta(company.id, grupo.id, 'Reciclagem').expect(201)).body;
      expect(outra.code).toBe('1.1.4');
    });

    it('ordena 1.2 antes de 1.10', async () => {
      const { company } = await cenario();
      const raiz = byCode(await tree(company.id), '2');
      for (const n of ['G7', 'G8', 'G9', 'G10']) await novaConta(company.id, raiz.id, n).expect(201);
      const codes = (await tree(company.id)).filter((r) => r.level === 2 && r.code.startsWith('2.')).map((r) => r.code);
      expect(codes).toEqual(['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10']);
    });

    it('recusa 4º nível, nome repetido na mesma mãe, sem nome e mãe inativa', async () => {
      const { company } = await cenario();
      const rows = await tree(company.id);
      await novaConta(company.id, byCode(rows, '1.1.1').id, 'Neta').expect(409);
      await novaConta(company.id, byCode(rows, '1.1').id, 'turmas FECHADAS (in company)').expect(409);
      await novaConta(company.id, byCode(rows, '1.1').id, ' ').expect(400);
      await api().post('/financial/chart-accounts').set(auth(company.id)).send({ name: 'Sem mãe' }).expect(400);
      // mesmo nome em outra mãe é permitido
      await novaConta(company.id, byCode(rows, '1.2').id, 'Turmas fechadas (in company)').expect(201);
    });

    it('ao criar filha em conta com lançamentos, eles passam para a filha', async () => {
      const { db, company, customer } = await cenario();
      const pessoal = byCode(await tree(company.id), '2.1');
      const { body: record } = await lancar(company.id, customer.id, { chartAccountId: pessoal.id }).expect(201);

      const filha = (await novaConta(company.id, pessoal.id, 'Salários').expect(201)).body;
      expect(filha).toMatchObject({ code: '2.1.1', movedEntries: 1 });
      expect((await db.financialRecords.findUnique({ where: { id: record.id } })).chartAccountId).toBe(filha.id);
      expect(byCode(await tree(company.id), '2.1').acceptsEntries).toBe(false);
      // a mãe deixou de aceitar lançamento
      await lancar(company.id, customer.id, { chartAccountId: pessoal.id }).expect(400);
    });

    it('exige permissão', async () => {
      const { company } = await cenario();
      const grupo = byCode(await tree(company.id), '1.1');
      await api().post('/financial/chart-accounts').set(auth(company.id, ['list_financeiro'])).send({ parentId: grupo.id, name: 'X' }).expect(403);
      await api().get('/financial/chart-accounts').expect(401);
    });
  });

  describe('editar, mover e inativar', () => {
    it('renomeia; raízes não mudam', async () => {
      const { company } = await cenario();
      const rows = await tree(company.id);
      const conta = byCode(rows, '1.2.3');
      await api().put(`/financial/chart-accounts/${conta.id}`).set(auth(company.id)).send({ name: 'Consultorias' }).expect(200);
      await api().put(`/financial/chart-accounts/${conta.id}`).set(auth(company.id)).send({ name: 'Brigada e resgate' }).expect(409);
      const raiz = byCode(rows, '1');
      await api().put(`/financial/chart-accounts/${raiz.id}`).set(auth(company.id)).send({ name: 'Entradas' }).expect(409);
      await api().patch(`/financial/chart-accounts/inactive/${raiz.id}`).set(auth(company.id)).expect(409);
      await api().patch(`/financial/chart-accounts/move/${raiz.id}`).set(auth(company.id)).send({ parentId: byCode(rows, '2').id }).expect(409);
      expect(byCode(await tree(company.id), '1.2.3').name).toBe('Consultorias');
    });

    it('move um grupo com as filhas e recodifica tudo', async () => {
      const { company } = await cenario();
      let rows = await tree(company.id);
      const loja = byCode(rows, '1.3');
      const venda = byCode(rows, '1.3.1');

      // grupo com filha não cabe dentro de outro grupo (4 níveis)
      await api().patch(`/financial/chart-accounts/move/${loja.id}`).set(auth(company.id)).send({ parentId: byCode(rows, '1.4').id }).expect(409);
      // dentro de si mesma / da própria filha
      await api().patch(`/financial/chart-accounts/move/${loja.id}`).set(auth(company.id)).send({ parentId: venda.id }).expect(409);
      await api().patch(`/financial/chart-accounts/move/${loja.id}`).set(auth(company.id)).send({ parentId: loja.id }).expect(409);

      // sem lançamentos, pode ir para Despesas: natureza acompanha
      await api().patch(`/financial/chart-accounts/move/${loja.id}`).set(auth(company.id)).send({ parentId: byCode(rows, '2').id }).expect(200);
      rows = await tree(company.id);
      const movido = rows.find((r) => r.id === loja.id)!;
      const filha = rows.find((r) => r.id === venda.id)!;
      expect(movido).toMatchObject({ code: '2.7', nature: 'despesa', level: 2 });
      expect(filha).toMatchObject({ code: '2.7.1', nature: 'despesa', level: 3, parentId: loja.id });
    });

    it('move uma conta filha; a mãe antiga sem filhas volta a aceitar lançamento', async () => {
      const { company } = await cenario();
      let rows = await tree(company.id);
      const venda = byCode(rows, '1.3.1');
      await api().patch(`/financial/chart-accounts/move/${venda.id}`).set(auth(company.id)).send({ parentId: byCode(rows, '1.4').id }).expect(200);
      rows = await tree(company.id);
      expect(rows.find((r) => r.id === venda.id)).toMatchObject({ code: '1.4.2', level: 3 });
      expect(byCode(rows, '1.3')).toMatchObject({ acceptsEntries: true, children: 0 });
    });

    it('não troca de natureza com lançamentos, nem entra em conta que tem lançamentos', async () => {
      const { company, customer } = await cenario();
      const rows = await tree(company.id);
      const inscricoes = byCode(rows, '1.1.1');
      await lancar(company.id, customer.id, { chartAccountId: inscricoes.id }).expect(201);
      await api().patch(`/financial/chart-accounts/move/${inscricoes.id}`).set(auth(company.id)).send({ parentId: byCode(rows, '2.2').id }).expect(409);

      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '2.1').id }).expect(201);
      await api().patch(`/financial/chart-accounts/move/${byCode(rows, '1.4.1').id}`).set(auth(company.id)).send({ parentId: byCode(rows, '2.1').id }).expect(409);
    });

    it('inativar: bloqueia com filha ativa, lançamento em aberto ou uso na classificação automática', async () => {
      const { company, customer } = await cenario();
      const rows = await tree(company.id);
      const inativar = (id: number) => api().patch(`/financial/chart-accounts/inactive/${id}`).set(auth(company.id));

      await inativar(byCode(rows, '1.2').id).expect(409); // tem filhas ativas
      await inativar(byCode(rows, '1.1.1').id).expect(409); // padrão da inscrição

      const altura = byCode(rows, '1.2.1');
      const { body: record } = await lancar(company.id, customer.id, { chartAccountId: altura.id }).expect(201);
      await inativar(altura.id).expect(409); // lançamento em aberto
      await api().patch(`/financial-records/settle/${record.id}`).set(auth(company.id)).send({}).expect(200);
      await inativar(altura.id).expect(200); // baixado não segura

      // inativa some da lista padrão, aparece com ?inactive=true, e não classifica lançamento novo
      expect((await tree(company.id)).some((r) => r.id === altura.id)).toBe(false);
      expect((await tree(company.id, { inactive: 'true' })).find((r) => r.id === altura.id).inactiveAt).not.toBeNull();
      await lancar(company.id, customer.id, { chartAccountId: altura.id }).expect(400);
      // quem já estava classificado continua podendo ser editado
      await api().put(`/financial-records/${record.id}`).set(auth(company.id)).send({ description: 'ok', chartAccountId: altura.id }).expect(200);
    });

    it('reativar exige a mãe ativa', async () => {
      const { company } = await cenario();
      const rows = await tree(company.id);
      const grupo = byCode(rows, '1.3');
      const filha = byCode(rows, '1.3.1');
      const set = (action: string, id: number) => api().patch(`/financial/chart-accounts/${action}/${id}`).set(auth(company.id));
      await set('inactive', filha.id).expect(200);
      await set('inactive', grupo.id).expect(200);
      await set('active', filha.id).expect(409);
      await set('active', grupo.id).expect(200);
      await set('active', filha.id).expect(200);
    });
  });

  describe('classificação dos recebíveis', () => {
    it('só aceita conta filha ativa da própria empresa', async () => {
      const { db, company, customer } = await cenario();
      const rows = await tree(company.id);
      const outra = await makeCompany();
      const alheia = byCode(await tree(outra.id), '1.1.1');
      const centro = await db.financial_CostCenter.findFirst({ where: { companyId: company.id, name: 'Serviços' } });

      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1.1').id }).expect(400); // conta mãe
      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1').id }).expect(400); // raiz
      await lancar(company.id, customer.id, { chartAccountId: alheia.id }).expect(400); // outra empresa
      await lancar(company.id, customer.id, { chartAccountId: 999999 }).expect(400);
      await lancar(company.id, customer.id, { costCenterId: 999999 }).expect(400);
      expect(await db.financialRecords.count()).toBe(0);

      const { body } = await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1.2.2').id, costCenterId: centro.id }).expect(201);
      const lista = await api().get('/financial-records').query({ show: 'chartAccount,costCenter', chartAccountId: byCode(rows, '1.2.2').id }).set(auth(company.id)).expect(200);
      expect(lista.body.total).toBe(1);
      expect(lista.body.rows[0]).toMatchObject({ id: body.id, chartAccount: { code: '1.2.2', name: 'Brigada e resgate' }, costCenter: { name: 'Serviços' } });
    });

    it('lançamento sem classificação continua valendo (e usa o padrão manual, se houver)', async () => {
      const { db, company, customer } = await cenario();
      const rows = await tree(company.id);
      const semPadrao = (await lancar(company.id, customer.id).expect(201)).body;
      expect((await db.financialRecords.findUnique({ where: { id: semPadrao.id } })).chartAccountId).toBeNull();

      const centro = await db.financial_CostCenter.findFirst({ where: { companyId: company.id, name: 'Serviços' } });
      await api().put('/financial/classification-defaults/manual').set(auth(company.id))
        .send({ chartAccountId: byCode(rows, '1.2.3').id, costCenterId: centro.id }).expect(200);
      const comPadrao = (await lancar(company.id, customer.id).expect(201)).body;
      expect(await db.financialRecords.findUnique({ where: { id: comPadrao.id } })).toMatchObject({ chartAccountId: byCode(rows, '1.2.3').id, costCenterId: centro.id });

      // padrão não aceita conta mãe nem origem desconhecida
      await api().put('/financial/classification-defaults/manual').set(auth(company.id)).send({ chartAccountId: byCode(rows, '1.2').id }).expect(400);
      await api().put('/financial/classification-defaults/qualquer').set(auth(company.id)).send({}).expect(400);
    });

    it('totais sobem das filhas para as mães e respeitam o mês', async () => {
      const { company, customer } = await cenario();
      const rows = await tree(company.id);
      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1.1.2').id, value: 1000, dueDate: '2026-12-10' }).expect(201);
      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1.1.2').id, value: 500, dueDate: '2027-01-10' }).expect(201);
      await lancar(company.id, customer.id, { chartAccountId: byCode(rows, '1.2.1').id, value: 250.5, dueDate: '2026-12-15' }).expect(201);

      const tudo = await tree(company.id);
      expect(byCode(tudo, '1.1.2')).toMatchObject({ entries: 2, total: 1500 });
      expect(byCode(tudo, '1.1')).toMatchObject({ entries: 2, total: 1500 });
      expect(byCode(tudo, '1')).toMatchObject({ entries: 3, total: 1750.5 });
      expect(byCode(tudo, '2')).toMatchObject({ entries: 0, total: 0 });

      const dezembro = await tree(company.id, { month: '2026-12' });
      expect(byCode(dezembro, '1.1')).toMatchObject({ entries: 1, total: 1000 });
      expect(byCode(dezembro, '1')).toMatchObject({ entries: 2, total: 1250.5 });
      await api().get('/financial/chart-accounts').query({ month: 'dez/26' }).set(auth(company.id)).expect(400);
    });
  });

  describe('classificação automática da inscrição', () => {
    const buyer = { name: 'Rita Nunes', cpf: '86288366757', email: 'rita@teste.local', phone: '81933332222', paymentMethod: 'pix' };
    async function turma(companyId: number) {
      await makeGateway(companyId, { gateway: 'manual', payload: {}, active: true });
      const course = await makeCourse(companyId);
      return makeCourseClass(companyId, course.id, { price: 500 });
    }
    function inscrever(classId: number, extra: Record<string, string> = {}) {
      const req = api().post('/subscription/subscribe');
      Object.entries({ ...buyer, ...extra, classId: String(classId) }).forEach(([k, v]) => req.field(k, v));
      return req;
    }

    it('empresa que nunca abriu o financeiro: inscrição funciona e nasce sem classificação', async () => {
      const { db, company } = await cenario();
      const courseClass = await turma(company.id);
      const res = await inscrever(courseClass.id).expect(201);
      const record = await db.financialRecords.findUnique({ where: { id: res.body.financialRecordId } });
      expect(record.chartAccountId).toBeNull();
      expect(record.costCenterId).toBeNull();
      expect(await db.financial_ChartAccount.count()).toBe(0); // o checkout não cria plano de contas
    });

    it('com o plano criado, a inscrição já sai classificada; padrão inválido não derruba a venda', async () => {
      const { db, company } = await cenario();
      await tree(company.id);
      const courseClass = await turma(company.id);

      const res = await inscrever(courseClass.id).expect(201);
      const record = await db.financialRecords.findUnique({ where: { id: res.body.financialRecordId }, include: { chartAccount: true, costCenter: true } });
      expect(record.chartAccount.code).toBe('1.1.1');
      expect(record.costCenter.name).toBe('Treinamentos');

      // centro de custo padrão inativado direto no banco: a venda segue, só sem centro
      await db.financial_CostCenter.updateMany({ where: { companyId: company.id, name: 'Treinamentos' }, data: { inactiveAt: new Date() } });
      const outra = await inscrever(courseClass.id, { cpf: '11144477735', email: 'outra@teste.local' }).expect(201);
      const segundo = await db.financialRecords.findUnique({ where: { id: outra.body.financialRecordId } });
      expect(segundo.chartAccountId).toBe(record.chartAccountId);
      expect(segundo.costCenterId).toBeNull();
    });

    it('aplica o padrão aos recebíveis de inscrição antigos, sem sobrescrever', async () => {
      const { db, company, customer } = await cenario();
      const courseClass = await turma(company.id);
      const antiga = await inscrever(courseClass.id).expect(201); // antes do plano existir
      const rows = await tree(company.id);
      const manual = (await lancar(company.id, customer.id).expect(201)).body; // não é inscrição
      const outroCentro = await db.financial_CostCenter.findFirst({ where: { companyId: company.id, name: 'Loja' } });
      await db.financialRecords.update({ where: { id: antiga.body.financialRecordId }, data: { costCenterId: outroCentro.id } });

      const pendentes = await api().get('/financial/classification-defaults').set(auth(company.id)).expect(200);
      expect(pendentes.body.pendingSubscriptionRecords).toBe(1);
      expect(pendentes.body.rows.find((r: any) => r.origin === 'inscricao').chartAccount.code).toBe('1.1.1');

      const res = await api().post('/financial/classification-defaults/apply').set(auth(company.id)).expect(201);
      expect(res.body).toEqual({ chartAccount: 1, costCenter: 0 });
      expect(await db.financialRecords.findUnique({ where: { id: antiga.body.financialRecordId } }))
        .toMatchObject({ chartAccountId: byCode(rows, '1.1.1').id, costCenterId: outroCentro.id });
      expect((await db.financialRecords.findUnique({ where: { id: manual.id } })).chartAccountId).toBeNull();
    });
  });

  describe('centros de custo', () => {
    it('cadastra, recusa nome repetido e não inativa com lançamento em aberto', async () => {
      const { company, customer } = await cenario();
      await tree(company.id);
      const criar = (name: string) => api().post('/financial-cost-centers').set(auth(company.id)).send({ name });
      const obras = (await criar('  Obras  especiais ').expect(201)).body;
      expect(obras.name).toBe('Obras especiais');
      await criar('obras ESPECIAIS').expect(409);
      await criar('Treinamentos').expect(409); // já veio no padrão
      await criar(' ').expect(400);

      const { body: record } = await lancar(company.id, customer.id, { costCenterId: obras.id }).expect(201);
      await api().patch(`/financial-cost-centers/inactive/${obras.id}`).set(auth(company.id)).expect(409);
      await api().patch(`/financial-records/settle/${record.id}`).set(auth(company.id)).send({}).expect(200);
      await api().patch(`/financial-cost-centers/inactive/${obras.id}`).set(auth(company.id)).expect(200);
      await lancar(company.id, customer.id, { costCenterId: obras.id }).expect(400);

      const lista = await api().get('/financial-cost-centers').query({ show: '_count', 'order-name': 'asc', active: 'true' }).set(auth(company.id)).expect(200);
      expect(lista.body.rows.map((r: any) => r.name)).toEqual(['Administrativo', 'Loja', 'Serviços', 'Treinamentos']);
    });

    it('centro usado na classificação automática não pode ser inativado', async () => {
      const { db, company } = await cenario();
      await tree(company.id);
      const centro = await db.financial_CostCenter.findFirst({ where: { companyId: company.id, name: 'Treinamentos' } });
      await api().patch(`/financial-cost-centers/inactive/${centro.id}`).set(auth(company.id)).expect(409);
    });
  });

  describe('contas bancárias', () => {
    const conta = (companyId: number, body: Record<string, any>) => api().post('/financial-bank-accounts').set(auth(companyId)).send(body);

    it('cadastra com dígito em texto, uma só padrão, e valida conta de gateway', async () => {
      const { db, company } = await cenario();
      const itau = (await conta(company.id, {
        name: 'Itaú principal', type: 'corrente', bankCode: '341', bankName: 'Itaú', agency: '0123', agencyDigit: 'X',
        account: '004567', accountDigit: '0', pixKey: 'financeiro@worksafe.local', openingBalance: 1500.5, isDefault: true,
      }).expect(201)).body;
      expect(itau).toMatchObject({ agencyDigit: 'X', account: '004567', accountDigit: '0', isDefault: true });

      const caixa = (await conta(company.id, { name: 'Caixa', type: 'caixa', isDefault: true }).expect(201)).body;
      expect((await db.financial_BankAccount.findUnique({ where: { id: itau.id } })).isDefault).toBe(false);
      expect(caixa.isDefault).toBe(true);

      await conta(company.id, { name: 'itaú PRINCIPAL' }).expect(409);
      await conta(company.id, { name: 'Sem provedor', type: 'gateway' }).expect(400);
      await conta(company.id, { name: 'Asaas', type: 'gateway', gateway: 'asaas' }).expect(201);
      await conta(company.id, { name: 'Asaas 2', type: 'gateway', gateway: 'asaas' }).expect(409);
      await conta(company.id, { name: 'Tipo errado', type: 'investimento' }).expect(400);
    });

    it('baixa registra a conta; saldo = inicial + baixas (+ recebido pelo gateway); estorno desfaz', async () => {
      const { db, company, customer } = await cenario();
      const itau = (await conta(company.id, { name: 'Itaú', openingBalance: 1000 }).expect(201)).body;
      const asaas = (await conta(company.id, { name: 'Asaas', type: 'gateway', gateway: 'asaas' }).expect(201)).body;
      const outra = await makeCompany();
      const alheia = (await conta(outra.id, { name: 'De outra empresa' }).expect(201)).body;

      const { body: a } = await lancar(company.id, customer.id, { value: 800, netValue: 700 }).expect(201);
      const { body: b } = await lancar(company.id, customer.id, { value: 300 }).expect(201);
      const settle = (id: number, body: Record<string, any>) => api().patch(`/financial-records/settle/${id}`).set(auth(company.id)).send(body);

      await settle(a.id, { bankAccountId: alheia.id }).expect(400);
      await settle(a.id, { bankAccountId: itau.id }).expect(200); // entra o líquido: 700
      await settle(b.id, { bankAccountId: itau.id, receivedValue: 290 }).expect(200);
      // recebido pelo Asaas (webhook): sem conta gravada, conta no saldo da conta de gateway
      await db.financialRecords.create({ data: { companyId: company.id, gateway: 'asaas', status: 'received', paymentMethod: 'pix',
        value: 120, accrualDate: '2026-11', paidAt: new Date(), externalId: 'pay_x' } });
      await db.financialRecords.create({ data: { companyId: company.id, gateway: 'asaas', status: 'waiting', paymentMethod: 'pix',
        value: 999, accrualDate: '2026-11', externalId: 'pay_y' } });

      const saldos = async () => Object.fromEntries(
        (await api().get('/financial/bank-balances').set(auth(company.id)).expect(200)).body.map((s: any) => [s.id, s.balance]));
      expect(await saldos()).toEqual({ [itau.id]: 1990, [asaas.id]: 120 });

      await api().patch(`/financial-records/unsettle/${b.id}`).set(auth(company.id)).expect(200);
      expect((await db.financialRecords.findUnique({ where: { id: b.id } })).bankAccountId).toBeNull();
      expect((await saldos())[itau.id]).toBe(1700);

      // conta bancária não muda por PUT, só pela baixa
      await api().put(`/financial-records/${b.id}`).set(auth(company.id)).send({ bankAccountId: itau.id, description: 'x' }).expect(200);
      expect((await db.financialRecords.findUnique({ where: { id: b.id } })).bankAccountId).toBeNull();
      // conta inativa não recebe baixa
      await api().patch(`/financial-bank-accounts/inactive/${itau.id}`).set(auth(company.id)).expect(200);
      await settle(b.id, { bankAccountId: itau.id }).expect(400);
    });
  });
});
