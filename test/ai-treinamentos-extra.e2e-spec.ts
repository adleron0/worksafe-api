import './setup/env'; // precisa ser o primeiro import

import { TRAINING_EXTRA_TOOLS } from 'src/features/ai/tools/training-extra.tools';
import { TRAINING_TOOLS } from 'src/features/ai/tools/training.tools';
import { ToolDeps } from 'src/features/ai/tools/tool.deps';
import { ToolContext, ToolDefinition, ToolRefusal } from 'src/features/ai/tools/tool.types';
import { bootTestApp, shutdownTestApp } from './setup/app';
import { testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Ferramentas extras da Lia (Treinamentos): reciclagem, cursos, instrutores,
 * presença, prova, emissão/reenvio de certificado, cancelamento e vagas de
 * empresa. O catálogo ainda não registra TRAINING_EXTRA_TOOLS: o teste chama
 * run/prepare/execute direto, com o ToolDeps do app (as escritas vão pelas
 * rotas da tela via deps.api.call).
 *
 * Banco compartilhado com outras suítes: nada de resetDb; cada teste cria a
 * própria empresa com dados únicos.
 */
describe('Lia: ferramentas extras de treinamentos (e2e)', () => {
  const PERMS = ['list_classes', 'create_classes', 'update_classes', 'list_treinamentos', 'list_instrutores', 'list_comercial'];
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let seq = 0;
  let cpfSeq = Math.floor(Math.random() * 1e8);
  let deps: ToolDeps;

  beforeAll(async () => {
    const app = await bootTestApp();
    deps = app.get(ToolDeps, { strict: false });
  });
  afterAll(async () => { await shutdownTestApp(); });

  const tool = (name: string): ToolDefinition => {
    const found = TRAINING_EXTRA_TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`ferramenta ${name} não existe`);
    return found;
  };

  /** CPF válido e diferente a cada chamada. */
  function cpf() {
    const base = String(++cpfSeq).padStart(9, '0').slice(-9).split('').map(Number);
    const dv = (nums: number[]) => { const sum = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
    const d1 = dv(base);
    return [...base, d1, dv([...base, d1])].join('');
  }

  async function cenario(classOverrides: Record<string, any> = {}) {
    const n = ++seq;
    const db = testDb();
    const company = await makeCompany({ cnpj: String(50000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Trein ${uniq} ${n}` });
    const user = await makeSeller(company.id, { email: `trein-${uniq}-${n}@teste.local`, cpf: String(10000000000 + Math.floor(Math.random() * 8e10)) });
    const ctx: ToolContext = { userId: user.id, companyId: company.id, permissions: PERMS, origin: 'bots' };
    const course = await makeCourse(company.id, { name: `NR-35 ${uniq} ${n}`, yearOfValidation: 2 });
    const model = await db.couseCertificate.create({ data: { name: 'Modelo NR-35', courseId: course.id, companyId: company.id, fabricJsonFront: { objects: [] }, fabricJsonBack: { objects: [] } } });
    const turma = await makeCourseClass(company.id, course.id, {
      name: `Turma ${uniq} ${n}`, daysDuration: 2, certificateId: model.id,
      initialDate: new Date('2027-03-10T12:00:00Z'), finalDate: new Date('2027-03-11T12:00:00Z'), ...classOverrides,
    });
    const aluno = async (name: string, email: string | null = `${name.split(' ')[0].toLowerCase()}-${uniq}@x.local`) => {
      const doc = cpf();
      const trainee = await db.trainee.create({ data: { name, cpf: doc, email } });
      await db.traineeCompany.create({ data: { traineeId: trainee.id, companyId: company.id } });
      const sub = await db.courseClassSubscription.create({ data: { name, cpf: doc, email: email ?? 'x@x.local', phone: '81999990000', classId: turma.id, companyId: company.id, subscribeStatus: 'confirmed', traineeId: trainee.id, origin: 'sistema' } });
      return { trainee, sub, doc };
    };
    const run = (name: string, input: Record<string, unknown> = {}, c = ctx) => tool(name).run!(c, input, deps) as Promise<any>;
    const sensitive = async (name: string, input: Record<string, unknown>, c = ctx) => {
      const prepared = await tool(name).prepare!(c, input, deps);
      const result = await tool(name).execute!(c, prepared.payload, deps);
      return { prepared, result };
    };
    return { db, company, ctx, course, turma, aluno, run, sensitive };
  }

  it('declara riscos e permissões coerentes, sem repetir as ferramentas que já existem', () => {
    const names = TRAINING_EXTRA_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const existing of TRAINING_TOOLS.map((t) => t.name).concat('listar_turmas')) expect(names).not.toContain(existing);
    for (const t of TRAINING_EXTRA_TOOLS) {
      if (t.risk === 'sensitive') { expect(t.prepare).toBeTruthy(); expect(t.execute).toBeTruthy(); expect(t.run).toBeUndefined(); } else expect(t.run).toBeTruthy();
      expect(t.permissions.length + (t.anyPermissions?.length ?? 0)).toBeGreaterThan(0);
    }
    expect(tool('registrar_presenca').risk).toBe('draft');
    expect(tool('emitir_certificados').risk).toBe('sensitive');
    expect(tool('cancelar_inscricao').risk).toBe('sensitive');
  });

  it('cursos, instrutores livres e presença marcada pela rota da lista', async () => {
    const { db, company, ctx, course, turma, aluno, run } = await cenario();
    const ana = await aluno('Ana Pereira');
    const bruno = await aluno('Bruno Costa');

    const cursos = await run('listar_cursos', { busca: uniq });
    expect(cursos.cursos).toEqual([expect.objectContaining({ id: course.id, cargaHoraria: 8, validadeAnos: 2, turmasPorVir: 1, modelosDeCertificado: 1 })]);

    const livre = await db.instructor.create({ data: { name: 'Carlos Livre', companyId: company.id, email: 'c@x.local', cpf: cpf(), curriculum: '-', formation: 'Técnico' } });
    const ocupado = await db.instructor.create({ data: { name: 'Davi Ocupado', companyId: company.id, email: 'd@x.local', cpf: cpf(), curriculum: '-', formation: 'Engenheiro' } });
    await db.courseClassInstructor.create({ data: { classId: turma.id, instructorId: ocupado.id, companyId: company.id } });
    const instrutores = await run('instrutores_disponiveis', { de: '2027-03-11', ate: '2027-03-12' });
    expect(instrutores.disponiveis.map((i: any) => i.instrutorId)).toEqual([livre.id]);
    expect(instrutores.ocupados[0]).toMatchObject({ instrutorId: ocupado.id, turmas: [expect.objectContaining({ turmaId: turma.id })] });
    // pela turma: quem já está nela aparece como livre, marcado
    const pelaTurma = await run('instrutores_disponiveis', { turmaId: turma.id });
    expect(pelaTurma.disponiveis).toEqual(expect.arrayContaining([expect.objectContaining({ instrutorId: ocupado.id, jaNaTurma: true })]));

    await expect(run('registrar_presenca', { turmaId: turma.id, dia: 3, todos: true })).rejects.toThrow('de 1 a 2');
    const marcou = await run('registrar_presenca', { turmaId: turma.id, dia: 1, todos: true });
    expect(marcou).toMatchObject({ dia: 1, presente: true, marcados: 2, link: `/treinamentos/turmas/${turma.id}` });
    await run('registrar_presenca', { turmaId: turma.id, dia: 2, inscricaoIds: [ana.sub.id] });
    // de novo no mesmo dia: atualiza, não duplica (upsert composto da rota)
    await run('registrar_presenca', { turmaId: turma.id, dia: 2, inscricaoIds: [ana.sub.id] });
    expect(await db.courseClassAttendanceList.count({ where: { classId: turma.id, traineeId: ana.trainee.id, day: 2 } })).toBe(1);
    const row = await db.courseClassAttendanceList.findFirstOrThrow({ where: { classId: turma.id, traineeId: ana.trainee.id, day: 2 } });
    expect(row.companyId).toBe(ctx.companyId);

    const lista = await run('lista_de_presenca', { turmaId: turma.id });
    expect(lista.turma).toMatchObject({ id: turma.id, dias: 2 });
    expect(lista.porDia).toEqual([{ dia: 1, presentes: 2 }, { dia: 2, presentes: 1 }]);
    expect(lista.alunos.find((a: any) => a.inscricaoId === ana.sub.id)).toMatchObject({ diasPresente: [1, 2], faltas: 0 });
    expect(lista.alunos.find((a: any) => a.inscricaoId === bruno.sub.id)).toMatchObject({ diasPresente: [1], faltas: 1 });
    expect(JSON.stringify(lista)).not.toContain(ana.doc);
  });

  it('emite certificados só para os aprovados, no clique, e eles aparecem na reciclagem', async () => {
    const { db, turma, aluno, run, sensitive } = await cenario({ allowExam: true });
    const ana = await aluno('Ana Pereira');
    const bruno = await aluno('Bruno Costa');

    const prova = await run('registrar_resultado_prova', { inscricaoId: ana.sub.id, aprovado: true });
    expect(prova).toMatchObject({ aluno: 'Ana Pereira', resultado: 'aprovado' });
    await expect(run('registrar_resultado_prova', { inscricaoId: ana.sub.id, aprovado: false })).rejects.toThrow('já tem prova');

    const card = await tool('emitir_certificados').prepare!((await cenarioCtx()), { turmaId: turma.id }, deps).catch((e) => e);
    expect(card).toBeInstanceOf(ToolRefusal); // outra empresa não acha a turma

    const prepared = await tool('emitir_certificados').prepare!(ctxOf(turma.companyId!), { turmaId: turma.id }, deps);
    expect(prepared.summary).toContain('Emitir 1 certificado');
    expect(prepared.details!.find((d) => d.label === 'Recebem')!.value).toBe('Ana Pereira');
    expect(prepared.details!.find((d) => d.label === 'Ficam de fora')!.value).toContain('Bruno Costa (sem prova aprovada)');
    // nada antes do clique
    expect(await db.traineeCourseCertificate.count({ where: { classId: turma.id } })).toBe(0);

    const { result } = await sensitive('emitir_certificados', { turmaId: turma.id });
    expect(result.message).toContain('1 certificado(s) emitido(s)');
    const cert = await db.traineeCourseCertificate.findFirstOrThrow({ where: { classId: turma.id } });
    expect(cert.traineeId).toBe(ana.trainee.id);
    expect(await db.traineeCourseCertificate.count({ where: { classId: turma.id, traineeId: bruno.trainee.id } })).toBe(0);

    // de novo: ninguém para emitir
    await expect(tool('emitir_certificados').prepare!(ctxOf(turma.companyId!), { turmaId: turma.id }, deps)).rejects.toThrow('Ninguém para emitir');

    // vence daqui a 2 anos: entra na janela de reciclagem pedida
    const vence = cert.expirationDate!.toISOString().slice(0, 10);
    const reciclagem = await run('certificados_vencendo', { de: vence, ate: vence });
    expect(reciclagem.total).toBe(1);
    expect(reciclagem.certificados[0]).toMatchObject({ certificadoId: cert.id, aluno: 'Ana Pereira', turmaId: turma.id, situacao: 'a vencer', vence });
    expect(reciclagem.porEmpresa).toEqual([expect.objectContaining({ aVencer: 1 })]);
    expect(JSON.stringify(reciclagem)).not.toContain(ana.doc);
    // fora da janela padrão
    expect((await run('certificados_vencendo')).total).toBe(0);

    // reenviar: a empresa de teste não tem e-mail de envio configurado
    await expect(tool('reenviar_certificado').prepare!(ctxOf(turma.companyId!), { certificadoId: cert.id }, deps)).rejects.toThrow('e-mail de envio');
  });

  it('cancelar inscrição: recusa com presença, cancela no clique sem presença e grava o motivo', async () => {
    const { db, turma, aluno, run, sensitive } = await cenario();
    const ana = await aluno('Ana Pereira');
    const bruno = await aluno('Bruno Costa');
    await run('registrar_presenca', { turmaId: turma.id, dia: 1, inscricaoIds: [ana.sub.id] });

    await expect(tool('cancelar_inscricao').prepare!(ctxOf(turma.companyId!), { inscricaoId: ana.sub.id }, deps)).rejects.toThrow('presença registrada');

    const { prepared, result } = await sensitive('cancelar_inscricao', { inscricaoId: bruno.sub.id, motivo: 'desistiu pelo WhatsApp' });
    expect(prepared.summary).toContain('Cancelar a inscrição de Bruno Costa');
    expect(result.message).toContain('cancelada');
    const sub = await db.courseClassSubscription.findUniqueOrThrow({ where: { id: bruno.sub.id } });
    expect(sub).toMatchObject({ subscribeStatus: 'declined', declinedReason: 'desistiu pelo WhatsApp' });
    expect(sub.inactiveAt).toBeTruthy();
    await expect(tool('cancelar_inscricao').prepare!(ctxOf(turma.companyId!), { inscricaoId: bruno.sub.id }, deps)).rejects.toThrow('já está cancelada');

    // vagas de empresa: sem reservas, avisa
    const vagas = await run('vagas_empresas_turma', { turmaId: turma.id });
    expect(vagas.reservas).toEqual([]);
    expect(vagas.aviso).toContain('Nenhuma');
    await expect(run('vagas_empresas_turma', {})).rejects.toThrow('turma ou o cliente');
  });

  const ctxOf = (companyId: number): ToolContext => ({ userId: 0, companyId, permissions: PERMS, origin: 'bots' });
  async function cenarioCtx(): Promise<ToolContext> {
    const company = await makeCompany({ cnpj: String(40000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Outra ${uniq}` });
    return ctxOf(company.id);
  }
});
