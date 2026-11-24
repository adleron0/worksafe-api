import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { HR_TOOLS } from 'src/features/ai/tools/hr.tools';
import { ToolDeps } from 'src/features/ai/tools/tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Ferramentas do bot de RH e Departamento Pessoal. O catálogo ainda não as
 * registra: aqui elas são chamadas direto (run / prepare + execute), com as
 * dependências do app. Tudo passa pelas rotas da tela em nome da pessoa, então
 * as permissões e regras de lá valem aqui.
 */
describe('Bot de RH: ferramentas (e2e)', () => {
  const RH = [
    'list_funcionarios', 'view_funcionarios', 'create_funcionarios', 'update_funcionarios',
    'view_dados_pessoais_funcionarios', 'view_ocorrencias_funcionarios', 'update_ocorrencias_funcionarios',
    'view_alocacao', 'update_alocacao', 'view_documentos_funcionarios', 'update_documentos_funcionarios',
  ];
  let jwt: JwtService;
  let deps: ToolDeps;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    deps = app.get(ToolDeps);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const tool = (name: string): ToolDefinition => {
    const found = HR_TOOLS.find((item) => item.name === name);
    if (!found) throw new Error(`ferramenta ${name} não existe`);
    return found;
  };
  const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
  const auth = (companyId: number, permissions: string[] = RH) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };

  async function cenario(permissions = RH) {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    await db.commercial_Professional.create({ data: { companyId: company.id, name: 'Alpinista N2', salary: 4200 } });
    await db.commercial_Professional.create({ data: { companyId: company.id, name: 'Soldador', salary: 3800 } });
    const ctxOf = (perms: string[]): ToolContext => ({ userId, companyId: company.id, permissions: perms, origin: 'bots' });
    const ctx = ctxOf(permissions);
    const run = (name: string, input: Record<string, unknown> = {}, as = ctx) => tool(name).run!(as, input, deps) as Promise<any>;
    return { db, company, ctx, ctxOf, run };
  }

  it('lista as ferramentas com risco e permissões das rotas', () => {
    const names = HR_TOOLS.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ['listar_funcionarios', 'documentos_vencendo', 'quem_esta_livre']) expect(names).not.toContain(name);
    expect(tool('registrar_ausencia')).toMatchObject({ risk: 'sensitive', permissions: ['view_funcionarios', 'update_ocorrencias_funcionarios'] });
    expect(tool('cadastrar_funcionario')).toMatchObject({ risk: 'draft', permissions: ['create_funcionarios'] });
    expect(tool('ver_funcionario')).toMatchObject({ risk: 'read', permissions: ['view_funcionarios'] });
    for (const item of HR_TOOLS) expect(item.risk === 'sensitive' ? !!item.prepare && !!item.execute : !!item.run).toBe(true);
  });

  it('cadastra, mostra a ficha (sem CPF inteiro), atualiza e corrige documento', async () => {
    const { db, company, run } = await cenario();
    const cpf = '52998224725';

    // função que não existe: recusa com a lista
    await expect(run('cadastrar_funcionario', { nome: 'José da Silva', funcoes: ['Pintor'] })).rejects.toThrow(/Alpinista N2, Soldador/);

    const created = await run('cadastrar_funcionario', {
      nome: 'José da Silva', cpf: '529.982.247-25', telefone: '81 99999-0000', funcoes: ['alpinista', 'Soldador'], funcaoPrincipal: 'Soldador', contrato: 'clt', admissao: '2025-03-10',
    });
    expect(created).toMatchObject({ nome: 'José da Silva', funcao: 'Soldador', contrato: 'clt', cpfFinal: '***.***.*47-25', link: `/rh/funcionarios/${created.funcionarioId}` });
    expect(JSON.stringify(created)).not.toContain(cpf);
    const row = await db.hr_Employee.findUniqueOrThrow({ where: { id: created.funcionarioId }, include: { roles: true } });
    expect(row).toMatchObject({ cpf, companyId: company.id, contractType: 'clt' });
    expect(row.roles).toHaveLength(2);

    // mesmo nome de novo: recusa até confirmar homônimo
    await expect(run('cadastrar_funcionario', { nome: 'josé da silva' })).rejects.toThrow(/homonimo/);
    // CPF repetido: a rota recusa (409) e vira recusa
    await expect(run('cadastrar_funcionario', { nome: 'José da Silva', cpf, homonimo: true })).rejects.toThrow(/mesmo CPF|este CPF/);

    // documento com vencimento e atividade, pela tela
    const types = (await request(httpServer()).get('/hr-documents/types').set(auth(company.id)).expect(200)).body.rows as Array<{ id: number; name: string }>;
    const aso = types.find((type) => type.name === 'ASO')!;
    const doc = await db.hr_EmployeeDocument.create({ data: { companyId: company.id, employeeId: row.id, typeId: aso.id, issueDate: new Date(`${day(-360)}T00:00:00Z`), expiryDate: new Date(`${day(5)}T00:00:00Z`), fileKey: 'hr/x/y.pdf', fileName: 'aso.pdf', mimeType: 'application/pdf', size: 10 } });
    const activityTypes = (await request(httpServer()).get('/hr-activities/types').set(auth(company.id)).expect(200)).body.rows as Array<{ id: number; name: string }>;
    const ct = activityTypes.find((type) => type.name === 'Atividade no CT')!;
    await request(httpServer()).post('/hr-activities').set(auth(company.id)).send({ typeId: ct.id, startDate: day(2), endDate: day(4), employeeIds: [row.id], location: 'CT Recife' }).expect(201);

    const ficha = await run('ver_funcionario', { nome: 'josé' });
    expect(ficha).toMatchObject({ funcionarioId: row.id, funcao: 'Soldador', situacao: 'Ativo', dadosPessoais: { cpfFinal: '***.***.*47-25' }, epis: [], link: `/rh/funcionarios/${row.id}` });
    expect(JSON.stringify(ficha)).not.toContain(cpf);
    expect(ficha.documentos.vigentes).toEqual([expect.objectContaining({ documentoId: doc.id, tipo: 'ASO', vence: day(5), situacao: 'A vencer' })]);
    expect(ficha.alocacao).toEqual([expect.objectContaining({ tipo: 'atividade', o: 'Atividade no CT', local: 'CT Recife', de: day(2), ate: day(4) })]);

    // sem permissão de documentos nem de dados pessoais: a ficha esconde
    const limited = await run('ver_funcionario', { funcionarioId: row.id }, { ...(await cenarioCtx(company.id)), permissions: ['view_funcionarios'] });
    expect(limited.documentos).toBe('sem permissão');
    expect(limited.dadosPessoais).toBe('sem permissão');
    expect(limited.historico).toBeUndefined();

    const atividades = await run('atividades_funcionario', { funcionarioId: row.id });
    expect(atividades.atividades).toEqual([expect.objectContaining({ tipo: 'Atividade no CT', pessoas: ['José da Silva'] })]);
    const mapa = await run('mapa_alocacao', { de: day(0), ate: day(6) });
    expect(mapa.atividades).toEqual([expect.objectContaining({ nome: 'José da Silva', atividade: 'Atividade no CT' })]);
    expect(mapa.livres).toEqual([]);
    const tipos = await run('tipos_de_documento');
    expect(tipos.tipos).toEqual(expect.arrayContaining([expect.objectContaining({ nome: 'ASO', vence: true, validadeMeses: 12, obrigatorio: 'para todos' })]));

    // atualizar: só o que foi pedido
    const updated = await run('atualizar_funcionario', { funcionarioId: row.id, telefone: '81 98888-1111' });
    expect(updated).toMatchObject({ telefone: '81 98888-1111', alterado: ['phone'], funcao: 'Soldador' });
    // dado pessoal sem a permissão: não grava e avisa
    const noPersonal = ['view_funcionarios', 'update_funcionarios'];
    await expect(run('atualizar_funcionario', { funcionarioId: row.id, email: 'jose@x.local' }, { ...(await cenarioCtx(company.id)), permissions: noPersonal })).rejects.toThrow(/dados pessoais/);

    // corrigir o vencimento do ASO
    const fixed = await run('corrigir_documento', { documentoId: doc.id, vencimento: day(200) });
    expect(fixed.documento).toMatchObject({ documentoId: doc.id, vence: day(200), situacao: 'Em dia' });
    await expect(run('corrigir_documento', { documentoId: doc.id, vencimento: day(-400) })).rejects.toThrow(/antes da emissão/);
  });

  /** O mesmo usuário e empresa, para trocar só as permissões. */
  async function cenarioCtx(companyId: number): Promise<ToolContext> {
    return { userId, companyId, permissions: [], origin: 'bots' };
  }

  it('registra férias só no execute, avisa escala e recusa sem permissão ou fora da regra', async () => {
    const { db, company, ctx, ctxOf, run } = await cenario();
    const emp = await db.hr_Employee.create({ data: { companyId: company.id, name: 'Maria Lima', admissionDate: new Date('2024-01-02T00:00:00Z') } });
    const activityTypes = (await request(httpServer()).get('/hr-activities/types').set(auth(company.id)).expect(200)).body.rows as Array<{ id: number; name: string }>;
    await request(httpServer()).post('/hr-activities').set(auth(company.id)).send({ typeId: activityTypes[0].id, startDate: day(3), endDate: day(3), employeeIds: [emp.id] }).expect(201);
    const ausencia = tool('registrar_ausencia');

    // regras: férias sem fim, antes da admissão
    await expect(ausencia.prepare!(ctx, { funcionarioId: emp.id, tipo: 'ferias', inicio: day(0) }, deps)).rejects.toThrow(/até quando/);
    await expect(ausencia.prepare!(ctx, { funcionarioId: emp.id, tipo: 'afastamento', inicio: '2023-05-01' }, deps)).rejects.toThrow(/Admitido/);

    const prepared = await ausencia.prepare!(ctx, { nome: 'Maria', tipo: 'ferias', inicio: day(0), fim: day(9) }, deps);
    expect(prepared.summary).toContain('férias de Maria Lima');
    expect(prepared.details).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Atenção', value: expect.stringContaining(activityTypes[0].name) })]));
    expect(await db.hr_EmployeeEvent.count({ where: { employeeId: emp.id } })).toBe(0); // nada antes do clique

    // no clique, sem a permissão de lançar no histórico: a rota recusa
    await expect(ausencia.execute!(ctxOf(['view_funcionarios']), prepared.payload, deps)).rejects.toThrow(ToolRefusal);
    await expect(ausencia.execute!(ctxOf(['view_funcionarios']), prepared.payload, deps)).rejects.toThrow(/permissão/);
    expect(await db.hr_EmployeeEvent.count({ where: { employeeId: emp.id } })).toBe(0);

    const done = await ausencia.execute!(ctx, prepared.payload, deps);
    expect(done).toMatchObject({ link: `/rh/funcionarios/${emp.id}`, data: { situacaoHoje: 'De férias' } });
    const ferias = await db.hr_EmployeeEvent.findFirstOrThrow({ where: { employeeId: emp.id } });
    expect(ferias).toMatchObject({ type: 'ferias', createdByUserId: userId });
    // de novo no mesmo período: recusa já no prepare
    await expect(ausencia.prepare!(ctx, { funcionarioId: emp.id, tipo: 'ferias', inicio: day(5), fim: day(12) }, deps)).rejects.toThrow(/Já existe férias/);

    // atestado em aberto vira afastamento com o motivo; depois encerra
    const atestado = await ausencia.prepare!(ctx, { funcionarioId: emp.id, tipo: 'atestado', inicio: day(20), motivo: '3 dias' }, deps);
    expect(atestado.summary).toContain('atestado médico');
    const out = await ausencia.execute!(ctx, atestado.payload, deps);
    const registroId = (out.data as any).registroId;
    expect(await db.hr_EmployeeEvent.findUniqueOrThrow({ where: { id: registroId } })).toMatchObject({ type: 'afastamento', reason: 'Atestado médico: 3 dias', endDate: null });
    const encerrado = await run('encerrar_ausencia', { funcionarioId: emp.id, registroId, fim: day(22) });
    expect(encerrado.registro).toMatchObject({ tipo: 'Afastamento', de: day(20), ate: day(22) });

    // sem create_funcionarios, a rota recusa o cadastro
    await expect(run('cadastrar_funcionario', { nome: 'Pedro Alves' }, ctxOf(['view_funcionarios']))).rejects.toThrow(ToolRefusal);
  });
});
