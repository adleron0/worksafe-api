import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { EmailService } from 'src/features/email/email.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comercial — documento da proposta, link público e aceite.
 *
 * O que não pode quebrar: o cliente lê e aceita exatamente o documento
 * congelado no envio; a página pública nunca devolve custo, margem ou dado
 * interno; e o aceite guarda quem, quando, de onde e qual documento.
 */
describe('Comercial — documento, link público e aceite (e2e)', () => {
  const ALL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial', 'view_custos_comercial'];
  const EMAIL_ENV = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASSWORD'];
  let jwt: JwtService;
  let email: EmailService;
  let sent: Array<{ to: string; subject: string; html: string }> = [];
  let userId = 0;
  let cnpj = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    email = app.get(EmailService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => {
    await resetDb(); await flushCache(); resetAsaasMock();
    sent = [];
    testIp = `192.0.2.${++ipSeq}`;
    for (const key of EMAIL_ENV) delete process.env[key];
    jest.restoreAllMocks();
    jest.spyOn(email, 'initialize').mockImplementation(() => undefined);
    jest.spyOn(email, 'sendEmail').mockImplementation(async (options) => { sent.push({ to: String(options.to), subject: options.subject, html: options.html ?? '' }); });
  });
  const withEmail = () => { for (const key of EMAIL_ENV) process.env[key] = 'teste'; };

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());
  const pub = (key: string) => `/commercial/public/proposals/${key}`;
  // O link público tem limite de requisições por IP: cada teste usa um IP próprio para não esbarrar no dos outros.
  let testIp = '';
  let ipSeq = 0;
  const ppost = (url: string) => api().post(url).set('X-Forwarded-For', testIp);

  async function cenario(extra: Record<string, unknown> = {}) {
    const db = testDb();
    const company = await makeCompany({ system_domain: 'sistema.teste.local' });
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: {
      name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: String(11222333000100 + ++cnpj), companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', description: 'Jateamento e pintura do tanque 3.',
      contactName: 'Maria Souza', contactEmail: 'maria@alfa.local', workDays: 22, contingencyRate: 0.05, validUntil: '2099-12-31',
      commission: { rate: 0.02, base: 'faturado' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 28 }],
      ...extra,
    }).expect(201)).body;
    return { company, customer, h, options, proposal };
  }
  const enviar = async (h: Record<string, string>, id: number) =>
    (await api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: 'enviada' }).expect(200)).body;
  const aceite = (extra: Record<string, unknown> = {}) => ({
    name: 'Maria Souza', cpf: '529.982.247-25', role: 'Gerente de Suprimentos', email: 'maria@alfa.local', declaration: true, termsAccepted: true, ...extra,
  });

  it('primeira abertura cria termos e modelos padrão, sem duplicar', async () => {
    const { h, options } = await cenario();
    expect(options.templates.map((t: any) => [t.name, t.kind, t.isDefault])).toEqual([['Proposta de serviço', 'servico', true], ['Proposta de treinamento', 'treinamento', false]]);
    expect(options.terms.map((t: any) => t.kind)).toEqual(['aceite', 'pagamento', 'reequilibrio', 'cancelamento', 'obrigacoes', 'confidencialidade', 'lgpd']);
    expect(options.variables.some((v: any) => v.key === 'tabela_itens' && v.block)).toBe(true);
    await Promise.all([api().get('/commercial/templates').set(h), api().get('/commercial/terms').set(h)]);
    expect(await testDb().commercial_ProposalTemplate.count()).toBe(2);
    expect(await testDb().commercial_Term.count()).toBe(7);
  });

  it('modelos e termos: cadastro, limpeza do texto, padrão único e bloqueios', async () => {
    const { company, h } = await cenario();
    const term = (await api().post('/commercial/terms').set(h).send({ title: 'Garantia', kind: 'garantia', body: '<p onclick="x()">90 dias.<script>alert(1)</script></p>' }).expect(201)).body;
    expect(term.body).toBe('<p>90 dias.</p>');
    await api().post('/commercial/terms').set(h).send({ title: 'Vazio', body: '<p><br></p>' }).expect(400);
    await api().put(`/commercial/terms/${term.id}`).set(h).send({ title: 'Garantia dos serviços' }).expect(200);

    const template = (await api().post('/commercial/templates').set(h)
      .send({ name: 'Proposta curta', body: '<h1>{{proposta.numero}}</h1><p>{{tabela_itens}}</p><p>{{termos}}</p>', itemsMode: 'global', termIds: [term.id, 999999], isDefault: true }).expect(201)).body;
    expect(template).toMatchObject({ itemsMode: 'global', termIds: [term.id], isDefault: true, kind: null });
    const list = (await api().get('/commercial/templates').set(h).expect(200)).body;
    expect(list.filter((t: any) => t.isDefault).map((t: any) => t.name)).toEqual(['Proposta curta']);
    await api().post('/commercial/templates').set(h).send({ name: 'Sem texto', body: '' }).expect(400);

    await api().patch(`/commercial/templates/inactive/${template.id}`).set(h).expect(200);
    await api().patch(`/commercial/terms/inactive/${term.id}`).set(h).expect(200);
    expect((await api().get('/commercial/terms').set(h)).body).toHaveLength(7);
    expect((await api().get('/commercial/terms?inactive=true').set(h)).body).toHaveLength(8);

    // outra empresa não mexe nem usa
    const other = await makeCompany();
    await api().put(`/commercial/templates/${template.id}`).set(auth(other.id)).send({ name: 'Invadido' }).expect(404);
    await api().put(`/commercial/terms/${term.id}`).set(auth(other.id)).send({ title: 'Invadido' }).expect(404);
    await api().post('/commercial/templates').set(auth(company.id, ['list_comercial'])).send({ name: 'X', body: '<p>x</p>' }).expect(403);
  });

  it('pré-visualização monta o documento com o rascunho, sem gravar e sem custo', async () => {
    const { h, proposal } = await cenario();
    const preview = (await api().post(`/commercial/proposals/${proposal.id}/document-preview`).set(h).send({}).expect(201)).body;
    expect(preview.frozen).toBe(false);
    for (const text of ['Proposta comercial PC-', 'Indústria Alfa SA', 'A/C Maria Souza', 'Jateamento e pintura do tanque 3.', 'Alpinista N1', '20.589,11',
      'vinte mil, quinhentos e oitenta e nove reais e onze centavos', '28 dias após a emissão da nota fiscal', '31/12/2099', '<h3>Aceite</h3>', '22 dias úteis']) {
      expect(preview.html).toContain(text);
    }
    // nada de custo, margem, imposto, comissão ou "imprevisibilidade" no documento
    for (const hidden of ['10.392,60', '19.608,68', '4.323,71', '411,78', 'mprevisibilidade', 'argem']) expect(preview.html).not.toContain(hidden);

    // texto editado na proposta e formato da tabela valem só para ela
    const custom = (await api().post(`/commercial/proposals/${proposal.id}/document-preview`).set(h)
      .send({ documentBody: '<p>Prezada {{contato.nome}},</p><p>{{tabela_itens}}</p><script>x</script>', itemsMode: 'por_secao', termIds: [] }).expect(201)).body;
    expect(custom.html).toContain('Prezada Maria Souza,');
    expect(custom.html).toContain('Mão de obra');
    expect(custom.html).not.toContain('Alpinista N1');
    expect(custom.html).not.toContain('script');
    expect((await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } })).documentBody).toBeNull();
  });

  it('enviar congela o documento, gera o link e a página pública mostra só o documento', async () => {
    const { h, proposal } = await cenario();
    const sentProposal = await enviar(h, proposal.id);
    expect(sentProposal).toMatchObject({ status: 'enviada', documentFrozen: true });
    expect(sentProposal.publicKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(sentProposal.publicUrl).toBe(`https://sistema.teste.local/proposta/${sentProposal.publicKey}`);
    expect(sentProposal.documentHash).toHaveLength(64);
    expect(sentProposal.events.map((e: any) => e.type)).toEqual(['enviada']);
    // a proposta passa a ter o texto do modelo como documento próprio
    expect(sentProposal.draft.documentBody).toContain('{{tabela_itens}}');

    const view = (await api().get(pub(sentProposal.publicKey)).set('User-Agent', 'Navegador de teste').set('X-Forwarded-For', '203.0.113.9, 10.0.0.1').expect(200)).body;
    expect(Object.keys(view).sort()).toEqual(['accepted', 'canDecide', 'codeEmail', 'company', 'hash', 'html', 'number', 'requiresCode', 'status', 'title', 'validUntil']);
    expect(view).toMatchObject({ number: sentProposal.number, status: 'visualizada', canDecide: true, requiresCode: false, hash: sentProposal.documentHash, accepted: null });
    expect(view.html).toContain('20.589,11');
    const raw = JSON.stringify(view);
    for (const hidden of ['10392', '10.392', 'cost', 'margem', 'profit', 'snapshot', 'salary', 'commission', 'maria@alfa.local', 'contactEmail', 'customerId']) expect(raw).not.toContain(hidden);

    // primeira abertura registra a visualização, com IP e navegador; a segunda não repete
    await api().get(pub(sentProposal.publicKey)).expect(200);
    const after = (await api().get(`/commercial/proposals/${proposal.id}`).set(h).expect(200)).body;
    expect(after.status).toBe('visualizada');
    expect(after.events.map((e: any) => e.type)).toEqual(['enviada', 'visualizada']);
    expect(after.events[1]).toMatchObject({ ip: '203.0.113.9', userAgent: 'Navegador de teste' });

    // mudar o modelo ou a base depois não muda o que o cliente vê
    const template = (await api().get('/commercial/templates').set(h)).body[0];
    await api().put(`/commercial/templates/${template.id}`).set(h).send({ body: '<p>Outro texto</p>' }).expect(200);
    expect((await api().get(pub(sentProposal.publicKey)).expect(200)).body.hash).toBe(sentProposal.documentHash);

    await api().get(pub('00000000-0000-4000-8000-000000000000')).expect(404);
    await api().get(pub('qualquer-coisa')).expect(404);
    await api().get(pub(`${sentProposal.publicKey}' OR 1=1`)).expect(404);
  });

  it('aceite pelo link: valida os dados, grava as evidências e fecha a proposta', async () => {
    const { h, proposal } = await cenario();
    const key = (await enviar(h, proposal.id)).publicKey;
    const hash = (await api().get(pub(key)).expect(200)).body.hash;
    const post = (body: Record<string, unknown>) => ppost(`${pub(key)}/accept`).set('User-Agent', 'Navegador de teste').set('X-Forwarded-For', '198.51.100.7').send(body);

    await post(aceite({ name: 'Maria' })).expect(400);
    await post(aceite({ cpf: '111.111.111-11' })).expect(400);
    await post(aceite({ role: '' })).expect(400);
    await post(aceite({ email: 'sem-arroba' })).expect(400);
    await post(aceite({ declaration: false })).expect(400);
    await post(aceite({ termsAccepted: undefined })).expect(400);
    await post(aceite({ hash: 'a'.repeat(64) })).expect(409); // leu outro documento
    expect((await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('visualizada');

    const done = (await post(aceite({ hash })).expect(201)).body;
    expect(done).toEqual({ status: 'aceita', name: 'Maria Souza', hash });
    await post(aceite({ hash })).expect(409); // não aceita duas vezes
    await ppost(`${pub(key)}/refuse`).send({ name: 'Maria Souza' }).expect(409);

    const after = (await api().get(`/commercial/proposals/${proposal.id}`).set(h).expect(200)).body;
    expect(after).toMatchObject({ status: 'aceita', statusNote: 'Aceite eletrônico por Maria Souza' });
    expect(after.decidedAt).toBeTruthy();
    const evidence = after.events.find((e: any) => e.type === 'aceita');
    expect(evidence).toMatchObject({
      name: 'Maria Souza', cpf: '52998224725', role: 'Gerente de Suprimentos', email: 'maria@alfa.local',
      ip: '198.51.100.7', userAgent: 'Navegador de teste', documentHash: hash, codeVerified: false,
    });
    const view = (await api().get(pub(key)).expect(200)).body;
    expect(view).toMatchObject({ status: 'aceita', canDecide: false, accepted: { name: 'Maria Souza', role: 'Gerente de Suprimentos' } });
    expect(JSON.stringify(view)).not.toContain('52998224725');
    await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(409);
  });

  it('com e-mail configurado, o aceite exige o código enviado ao contato da proposta', async () => {
    const { h, proposal } = await cenario();
    withEmail();
    const key = (await enviar(h, proposal.id)).publicKey;
    const view = (await api().get(pub(key)).expect(200)).body;
    expect(view).toMatchObject({ requiresCode: true, codeEmail: 'ma***@alfa.local' });

    await ppost(`${pub(key)}/accept`).send(aceite()).expect(400); // sem pedir o código
    const asked = (await ppost(`${pub(key)}/code`).expect(201)).body;
    expect(asked).toEqual({ required: true, sentTo: 'ma***@alfa.local' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('maria@alfa.local');
    const code = sent[0].html.match(/<strong>(\d{6})<\/strong>/)![1];
    // o código não fica guardado em claro
    const stored = await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(stored.acceptCodeHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(code);

    const wrong = code === '000000' ? '000001' : '000000';
    await ppost(`${pub(key)}/accept`).send(aceite({ code: wrong })).expect(400);
    expect((await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } })).acceptCodeAttempts).toBe(1);
    await ppost(`${pub(key)}/accept`).send(aceite({ code })).expect(201);
    const evidence = (await api().get(`/commercial/proposals/${proposal.id}`).set(h)).body.events.find((e: any) => e.type === 'aceita');
    expect(evidence.codeVerified).toBe(true);
  });

  it('código: vence, e tentativas demais bloqueiam até pedir outro', async () => {
    const { h, proposal } = await cenario();
    withEmail();
    const key = (await enviar(h, proposal.id)).publicKey;
    await ppost(`${pub(key)}/code`).expect(201);
    const code = sent[0].html.match(/<strong>(\d{6})<\/strong>/)![1];
    const wrong = code === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) await ppost(`${pub(key)}/accept`).send(aceite({ code: wrong })).expect(400);
    const blocked = await ppost(`${pub(key)}/accept`).send(aceite({ code })).expect(400); // nem o certo passa mais
    expect(JSON.stringify(blocked.body)).toContain('Muitas tentativas');

    await testDb().commercial_Proposal.update({ where: { id: proposal.id }, data: { acceptCodeAttempts: 0, acceptCodeExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await ppost(`${pub(key)}/accept`).send(aceite({ code })).expect(400);
    expect(JSON.stringify(expired.body)).toContain('venceu');
  });

  it('recusa pelo link, com motivo; depois dá para criar uma revisão', async () => {
    const { h, proposal } = await cenario();
    const key = (await enviar(h, proposal.id)).publicKey;
    await ppost(`${pub(key)}/refuse`).send({ name: '' }).expect(400);
    await ppost(`${pub(key)}/refuse`).set('X-Forwarded-For', '198.51.100.8').send({ name: 'Maria Souza', reason: 'Preço acima do orçamento' }).expect(201);
    const after = (await api().get(`/commercial/proposals/${proposal.id}`).set(h).expect(200)).body;
    expect(after).toMatchObject({ status: 'recusada', statusNote: 'Recusada por Maria Souza: Preço acima do orçamento' });
    expect(after.events.find((e: any) => e.type === 'recusada')).toMatchObject({ name: 'Maria Souza', note: 'Preço acima do orçamento', ip: '198.51.100.8' });
    await ppost(`${pub(key)}/accept`).send(aceite()).expect(409);

    // revisão: link novo; o antigo avisa que foi substituído e não mostra mais o conteúdo
    const revision = (await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(201)).body;
    expect(revision).toMatchObject({ status: 'rascunho', publicKey: null, documentFrozen: false });
    expect(revision.draft.documentBody).toContain('{{tabela_itens}}');
    const old = (await api().get(pub(key)).expect(200)).body;
    expect(old).toMatchObject({ status: 'substituida', html: null, canDecide: false });
    const resent = await enviar(h, revision.id);
    expect(resent.publicKey).not.toBe(key);
    expect((await api().get(pub(resent.publicKey)).expect(200)).body.canDecide).toBe(true);
  });

  it('validade vencida: a proposta expira sozinha e o link não aceita mais', async () => {
    const { h, proposal } = await cenario();
    const key = (await enviar(h, proposal.id)).publicKey;
    await testDb().commercial_Proposal.update({ where: { id: proposal.id }, data: { validUntil: new Date('2020-01-01T00:00:00Z') } });
    const view = (await api().get(pub(key)).expect(200)).body;
    expect(view).toMatchObject({ status: 'expirada', canDecide: false });
    expect(view.html).toContain('20.589,11'); // continua legível
    await ppost(`${pub(key)}/accept`).send(aceite()).expect(410);
    const listed = (await api().get('/commercial/proposals').set(h).expect(200)).body;
    expect(listed.rows[0]).toMatchObject({ status: 'expirada' });
    expect((await api().get(`/commercial/proposals/${proposal.id}`).set(h)).body.events.map((e: any) => e.type)).toEqual(['enviada', 'expirada']);
    // expirada pode ser revisada
    await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(201);
  });

  it('cancelada ou ainda em rascunho: o link não mostra nada', async () => {
    const { h, proposal } = await cenario();
    expect(proposal.publicKey).toBeNull();
    const key = (await enviar(h, proposal.id)).publicKey;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'cancelada' }).expect(200);
    expect((await api().get(pub(key)).expect(200)).body).toMatchObject({ status: 'cancelada', html: null, canDecide: false });
    await ppost(`${pub(key)}/accept`).send(aceite()).expect(409);
  });

  it('enviar o link por e-mail: só com e-mail configurado e proposta enviada', async () => {
    const { h, proposal } = await cenario();
    await api().post(`/commercial/proposals/${proposal.id}/send-email`).set(h).send({ to: 'maria@alfa.local' }).expect(409); // rascunho
    const sentProposal = await enviar(h, proposal.id);
    expect(sentProposal.emailConfigured).toBe(false);
    const refused = await api().post(`/commercial/proposals/${proposal.id}/send-email`).set(h).send({ to: 'maria@alfa.local' }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('Copie o link');

    withEmail();
    await api().post(`/commercial/proposals/${proposal.id}/send-email`).set(h).send({ to: 'invalido' }).expect(400);
    await api().post(`/commercial/proposals/${proposal.id}/send-email`).set(h).send({ to: 'maria@alfa.local', message: 'Segue <b>nossa</b> proposta.' }).expect(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'maria@alfa.local', subject: expect.stringContaining(sentProposal.number) });
    expect(sent[0].html).toContain(sentProposal.publicUrl);
    expect(sent[0].html).toContain('Segue &lt;b&gt;nossa&lt;/b&gt; proposta.');
    expect((await api().get(`/commercial/proposals/${proposal.id}`).set(h)).body.events.map((e: any) => e.type)).toEqual(['enviada', 'email_enviado']);
    await api().post(`/commercial/proposals/${proposal.id}/send-email`).set(auth(proposal.id, ['list_comercial'])).send({ to: 'maria@alfa.local' }).expect(403);
  });

  it('hora extra só na linha de um profissional', async () => {
    const { h, options, customer } = await cenario();
    const pro = (name: string) => options.professionals.find((p: any) => p.name === name).id;
    const body = (overtimeHours: number) => ({
      kind: 'servico', customerId: customer.id, title: 'Resgate', workDays: 5, contingencyRate: 0,
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [
        { type: 'mao_de_obra', professionalId: pro('Resgatista'), quantity: 1, overtimeHours },
        { type: 'mao_de_obra', professionalId: pro('Alpinista N1'), quantity: 3 },
      ] }],
    });
    const plain = (await api().post('/commercial/proposals/preview').set(h).send(body(0)).expect(201)).body;
    const extra = (await api().post('/commercial/proposals').set(h).send(body(6)).expect(201)).body;
    const overtime = Math.round((1780.84 / 220) * 1.5 * 1.4616 * 6 * 100) / 100;
    expect(Math.round((extra.calc.sections[0].lines[0].cost - plain.sections[0].lines[0].cost) * 100) / 100).toBe(overtime);
    expect(extra.calc.sections[0].lines[1].cost).toBe(plain.sections[0].lines[1].cost);
    expect(extra.draft.sections[0].items[0].overtimeHours).toBe(6);
    const base = (await api().get('/commercial/cost-bases/current').set(h).expect(200)).body;
    expect(base.params.overtimeRate).toBe(0.5);
  });
});
