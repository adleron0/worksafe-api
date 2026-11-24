import './setup/env'; // precisa ser o primeiro import

import { READ_TOOLS } from 'src/features/ai/tools/read.tools';
import { ToolDeps } from 'src/features/ai/tools/tool.deps';
import { ToolContext, ToolRefusal } from 'src/features/ai/tools/tool.types';
import { bootTestApp, shutdownTestApp } from './setup/app';
import { testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Teste com o modelo econômico (24/11/2026): ele errou porque abrir proposta
 * só aceitava o id interno e porque leu mal o resumo por situação (pulou o
 * rascunho). Agora: abre pelo código PC-… e o resumo vem em lista.
 */
describe('Ferramentas de propostas: código PC e resumo com rascunho (e2e)', () => {
  const PERMS = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas'];
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let deps: ToolDeps;

  beforeAll(async () => {
    const app = await bootTestApp();
    deps = app.get(ToolDeps, { strict: false });
  });
  afterAll(async () => { await shutdownTestApp(); });

  const run = (name: string, ctx: ToolContext, input: Record<string, unknown>) => READ_TOOLS.find((t) => t.name === name)!.run!(ctx, input, deps) as Promise<any>;

  it('abre a proposta pelo código e o resumo traz o rascunho em lista', async () => {
    const db = testDb();
    const company = await makeCompany({ cnpj: String(60000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Prop ${uniq}` });
    const user = await makeSeller(company.id, { name: `Rafael ${uniq}`, email: `prop-${uniq}@teste.local`, cpf: String(10000000000 + Math.floor(Math.random() * 8e10)) });
    const ctx: ToolContext = { userId: user.id, companyId: company.id, permissions: PERMS, origin: 'bots' };
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = await db.customer.create({ data: {
      name: `Heineken ${uniq}`, corporateName: `Heineken ${uniq} SA`, cnpj: String(30000000000000 + Math.floor(Math.random() * 9e12)), companyId: company.id,
      rankId: rank.id, phone: '8133334444', email: 'compras@h.local', stateId: state.id, cityId: city.id,
    } });
    const options = await deps.api.call<any>(ctx, 'GET', 'commercial/proposals/options');
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const created = await deps.api.call<any>(ctx, 'POST', 'commercial/proposals', { body: {
      kind: 'servico', customerId: customer.id, title: 'Pintura', contactName: 'Maria', workDays: 5, contingencyRate: 0,
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
    } });
    const row = await db.commercial_Proposal.findUniqueOrThrow({ where: { id: created.id } });

    // pelo código, maiúsculo ou minúsculo; e pelo id como antes
    expect((await run('ver_proposta', ctx, { numero: row.number })).id).toBe(row.id);
    expect((await run('ver_proposta', ctx, { numero: row.number.toLowerCase() })).id).toBe(row.id);
    expect((await run('ver_proposta', ctx, { propostaId: row.id })).id).toBe(row.id);
    await expect(run('ver_proposta', ctx, { numero: 'PC-1999-9999' })).rejects.toBeInstanceOf(ToolRefusal);
    // código de outra empresa não abre
    const other = await makeCompany({ cnpj: String(70000000000000 + Math.floor(Math.random() * 9e12)), comercial_name: `Outra ${uniq}` });
    await expect(run('ver_proposta', { ...ctx, companyId: other.id }, { numero: row.number })).rejects.toBeInstanceOf(ToolRefusal);

    const list = await run('listar_propostas', ctx, {});
    expect(Array.isArray(list.resumoPorSituacao)).toBe(true);
    expect(list.resumoPorSituacao).toEqual(expect.arrayContaining([expect.objectContaining({ situacao: 'rascunho', quantidade: 1 })]));
    expect(list.observacao).toMatch(/rascunhos/);
  });
});
