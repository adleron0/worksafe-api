import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { BOT_DEFAULTS } from 'src/features/ai/bots/bot.defaults';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Lia inscrevendo alunos pelo chat e pelo MCP: o caso real é quem se inscreveu
 * pelo WhatsApp e já pagou. A inscrição vai pela rota da tela (mesmas regras
 * de CPF, vagas e reserva) e o "já pago" lança o recebível já baixado. Tudo só
 * depois do clique no cartão.
 */
describe('Lia: alunos e inscrições (e2e)', () => {
  const PERMS = ['usar_mcp', 'list_classes', 'create_classes', 'update_classes', 'list_financeiro', 'create_financeiro', 'update_financeiro'];
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;
  let cpfSeq = 300000000;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  /** CPF válido e diferente a cada chamada. */
  function cpf() {
    const base = String(++cpfSeq).padStart(9, '0').split('').map(Number);
    const dv = (nums: number[]) => { const sum = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
    const d1 = dv(base);
    const d2 = dv([...base, d1]);
    return [...base, d1, d2].join('');
  }
  const auth = (companyId: number, permissions: string[]) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  async function cenario(permissions = PERMS, classOverrides: Record<string, any> = {}) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const course = await makeCourse(company.id);
    const turma = await makeCourseClass(company.id, course.id, { name: 'Acesso por Corda N1', initialDate: new Date('2027-01-10T12:00:00Z'), finalDate: new Date('2027-01-15T12:00:00Z'), ...classOverrides });
    const ctx: ToolContext = { userId, companyId: company.id, permissions, origin: 'bots' };
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    const confirm = (id: number) => request(httpServer()).post(`/ai/actions/${id}/confirm`).set(auth(company.id, permissions)).expect(200);
    return { company, turma, call, confirm, db: testDb() };
  }
  async function makeCustomer(companyId: number) {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: { name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000199', companyId, rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id } });
  }

  it('Lia tem as ferramentas novas', () => {
    const lia = BOT_DEFAULTS.find((bot) => bot.key === 'treinamentos')!;
    for (const tool of ['listar_inscritos', 'buscar_aluno', 'cadastrar_aluno', 'inscrever_na_turma', 'vincular_empresa_inscricao']) {
      expect(lia.tools).toContain(tool);
      expect(catalog.get(tool)).toBeTruthy();
    }
    expect(catalog.get('inscrever_na_turma')!.risk).toBe('sensitive');
    expect(catalog.get('cadastrar_aluno')!.risk).toBe('draft');
  });

  it('inscreve quem pagou pelo WhatsApp: só no clique, com aluno ligado à empresa e pagamento recebido', async () => {
    const { company, turma, call, confirm, db } = await cenario();
    const doc = cpf();
    expect((await call('buscar_aluno', { busca: doc })).data.aviso).toContain('Nenhum aluno');

    // faltando dados: recusa com o motivo, para o modelo perguntar
    expect((await call('inscrever_na_turma', { turmaId: turma.id, nome: 'Maria Souza', cpf: doc, telefone: '81999990000' })).data.recusado).toContain('e-mail');
    expect((await call('inscrever_na_turma', { turmaId: turma.id, nome: 'Maria Souza', cpf: '12345678900', email: 'maria@x.local', telefone: '81999990000' })).data.recusado).toContain('CPF');
    expect((await call('inscrever_na_turma', { turmaId: turma.id, nome: 'Maria Souza', cpf: doc, email: 'maria@x.local', telefone: '81999990000', jaPago: true })).data.recusado).toContain('forma de pagamento');

    const pending = await call('inscrever_na_turma', {
      turmaId: turma.id, nome: 'Maria Souza', cpf: `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`, email: 'Maria@X.local', telefone: '(81) 99999-0000',
      jaPago: true, formaPagamento: 'pix', observacoes: 'pago pelo WhatsApp',
    });
    expect(pending.status).toBe('pending');
    expect(pending.data.resumo).toContain('Inscrever Maria Souza');
    expect(pending.data.resumo).toContain('R$');
    expect(pending.content).not.toContain(doc);
    // nada feito antes do clique
    expect(await db.courseClassSubscription.count({ where: { classId: turma.id } })).toBe(0);

    await confirm(pending.pendingActionId!);
    const sub = await db.courseClassSubscription.findFirstOrThrow({ where: { classId: turma.id } });
    expect(sub).toMatchObject({ name: 'Maria Souza', cpf: doc, email: 'maria@x.local', phone: '81999990000', subscribeStatus: 'confirmed', origin: 'sistema' });
    expect(sub.traineeId).toBeTruthy();
    expect(await db.traineeCompany.findFirst({ where: { traineeId: sub.traineeId!, companyId: company.id } })).toBeTruthy();
    const record = await db.financialRecords.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(record).toMatchObject({ gateway: 'manual', status: 'received', paymentMethod: 'pix', traineeId: sub.traineeId, observations: expect.stringContaining('WhatsApp') });
    expect(Number(record.value)).toBe(500);
    const action = await db.ai_PendingAction.findUniqueOrThrow({ where: { id: pending.pendingActionId! } });
    expect(action.error).toBeNull();

    // aparece na lista de Alunos (rota da tela) e nas consultas da Lia
    const alunos = (await request(httpServer()).get('/trainee').set(auth(company.id, PERMS)).expect(200)).body;
    expect(JSON.stringify(alunos)).toContain('Maria Souza');
    const found = await call('buscar_aluno', { busca: doc });
    expect(found.data.alunos).toHaveLength(1);
    expect(found.data.alunos[0]).toMatchObject({ alunoId: sub.traineeId, cpfFinal: `***.***.*${doc.slice(7, 9)}-${doc.slice(9)}` });
    expect(found.data.alunos[0].inscricoes[0]).toMatchObject({ turmaId: turma.id, situacao: 'confirmada' });
    expect((await call('buscar_aluno', { busca: 'maria' })).data.alunos).toHaveLength(1);
    const lista = await call('listar_inscritos', { turmaId: turma.id });
    expect(lista.status).toBe('ok');
    expect(lista.data.totais).toEqual({ confirmadas: 1, pendentes: 0 });
    expect(lista.data.inscritos[0]).toMatchObject({ nome: 'Maria Souza', situacao: 'confirmada', pagamento: { situacao: 'pago', valor: 500, forma: 'Pix' }, diasPresente: 0, prova: null, certificado: false });
    expect(lista.data.vagas).toMatchObject({ limite: 'ilimitado', confirmadas: 1 });
    expect(lista.content).not.toContain(doc);

    // de novo: já está confirmada
    expect((await call('inscrever_na_turma', { alunoId: sub.traineeId, turmaId: turma.id })).data.recusado).toContain('já está inscrita');
  });

  it('confirma a inscrição pendente do site em vez de duplicar, com empresa contratante', async () => {
    const { company, turma, call, confirm, db } = await cenario();
    const doc = cpf();
    const site = await db.courseClassSubscription.create({ data: { name: 'João Lima', cpf: doc, email: 'joao@x.local', phone: '81988887777', classId: turma.id, companyId: company.id, subscribeStatus: 'pending', origin: 'site' } });
    const customer = await makeCustomer(company.id);

    const found = await call('buscar_aluno', { busca: 'João' });
    expect(found.data.inscricoesSemCadastro[0]).toMatchObject({ inscricaoId: site.id, situacao: 'pendente' });

    const pending = await call('inscrever_na_turma', { turmaId: turma.id, nome: 'João Lima', cpf: doc, email: 'joao@x.local', telefone: '81988887777', clienteId: customer.id, jaPago: true, formaPagamento: 'transferencia', valorPago: 450 });
    expect(pending.data.resumo).toContain('Confirmar João Lima');
    await confirm(pending.pendingActionId!);
    expect(await db.courseClassSubscription.count({ where: { classId: turma.id } })).toBe(1);
    const sub = await db.courseClassSubscription.findUniqueOrThrow({ where: { id: site.id } });
    expect(sub).toMatchObject({ subscribeStatus: 'confirmed', customerId: customer.id });
    expect(sub.traineeId).toBeTruthy();
    const record = await db.financialRecords.findFirstOrThrow({ where: { subscriptionId: site.id } });
    expect(record).toMatchObject({ status: 'received', paymentMethod: 'transferencia', customerId: customer.id });
    expect(Number(record.value)).toBe(450);

    // tira a empresa da inscrição
    const desvincula = await call('vincular_empresa_inscricao', { inscricaoId: site.id, clienteId: 0 });
    expect(desvincula.data).toMatchObject({ empresa: null });
    expect((await db.courseClassSubscription.findUniqueOrThrow({ where: { id: site.id } })).customerId).toBeNull();
    expect((await call('vincular_empresa_inscricao', { inscricaoId: site.id, clienteId: customer.id })).data).toMatchObject({ empresa: 'Indústria Alfa' });
  });

  it('turma lotada não inscreve; cadastro de aluno não duplica CPF', async () => {
    const { company, turma, call, db } = await cenario(PERMS, { unlimitedSubscriptions: false, maxSubscriptions: 1 });
    await db.courseClassSubscription.create({ data: { name: 'Já Inscrito', cpf: cpf(), email: 'a@x.local', phone: '81900000000', classId: turma.id, companyId: company.id, subscribeStatus: 'confirmed' } });
    expect((await call('inscrever_na_turma', { turmaId: turma.id, nome: 'Ana Paula', cpf: cpf(), email: 'ana@x.local', telefone: '81977776666' })).data.recusado).toContain('lotada');

    const doc = cpf();
    expect((await call('cadastrar_aluno', { nome: 'Ana Paula', cpf: '11111111111' })).data.recusado).toContain('CPF');
    const first = await call('cadastrar_aluno', { nome: 'Ana Paula', cpf: doc, email: 'ana@x.local', telefone: '81977776666' });
    expect(first.data).toMatchObject({ nome: 'Ana Paula', jaExistia: false });
    const again = await call('cadastrar_aluno', { nome: 'Outro Nome', cpf: doc });
    expect(again.data).toMatchObject({ alunoId: first.data.alunoId, nome: 'Ana Paula', jaExistia: true });
    expect(await db.trainee.count({ where: { cpf: doc } })).toBe(1);
    expect(await db.traineeCompany.count({ where: { traineeId: first.data.alunoId, companyId: company.id } })).toBe(1);
  });

  it('respeita as permissões: sem financeiro inscreve sem lançar; só consulta não inscreve', async () => {
    const semFinanceiro = ['usar_mcp', 'list_classes', 'create_classes'];
    const { turma, call, confirm, db } = await cenario(semFinanceiro);
    const pending = await call('inscrever_na_turma', { turmaId: turma.id, nome: 'Carlos Dias', cpf: cpf(), email: 'carlos@x.local', telefone: '81966665555', jaPago: true, formaPagamento: 'dinheiro' });
    expect(pending.status).toBe('pending');
    const action = await db.ai_PendingAction.findUniqueOrThrow({ where: { id: pending.pendingActionId! } });
    expect(JSON.stringify(action.details)).toContain('NÃO será lançado');
    await confirm(pending.pendingActionId!);
    expect(await db.courseClassSubscription.count({ where: { classId: turma.id, subscribeStatus: 'confirmed' } })).toBe(1);
    expect(await db.financialRecords.count()).toBe(0);

    const leitor = await cenario(['list_classes']);
    expect((await leitor.call('listar_inscritos', { turmaId: leitor.turma.id })).status).toBe('ok');
    expect((await leitor.call('inscrever_na_turma', { turmaId: leitor.turma.id })).status).toBe('denied');
    expect((await leitor.call('cadastrar_aluno', { nome: 'X', cpf: '1' })).status).toBe('denied');
  });
});
