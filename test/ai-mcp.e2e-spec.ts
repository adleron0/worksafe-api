import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * MCP: um app de IA se registra, a pessoa aprova no sistema com o próprio
 * login, o app recebe um token só do MCP e usa as mesmas ferramentas dos bots,
 * com as permissões atuais da pessoa.
 */
describe('MCP com OAuth (e2e)', () => {
  let jwt: JwtService;
  let userId = 0;
  const REDIRECT = 'http://localhost:9999/callback';

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); delete process.env.MCP_ENABLED; });

  const auth = (companyId: number, permissions: string[]) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  const rpc = (token: string, method: string, params: Record<string, unknown> = {}, id = 1) =>
    api().post('/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').send({ jsonrpc: '2.0', id, method, params });

  async function grant(userIdToGrant: number, names: string[]) {
    const db = testDb();
    for (const name of names) {
      const permission = await db.permission.upsert({ where: { name }, create: { name, group: 'bots' }, update: {} });
      await db.userPermission.upsert({ where: { userId_permissionId: { userId: userIdToGrant, permissionId: permission.id } }, create: { userId: userIdToGrant, permissionId: permission.id }, update: { inactiveAt: null } });
    }
  }

  async function connect(companyId: number) {
    const registered = (await api().post('/register').send({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }).expect(201)).body;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await api().get('/authorize').query({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc123', scope: 'worksafe' }).expect(302);
    const location = new URL(authorize.headers.location);
    expect(location.pathname).toBe('/conectar-ia');
    const pedido = location.searchParams.get('pedido')!;
    const info = (await api().get('/ai/mcp/requests').query({ pedido }).set(auth(companyId, ['usar_mcp'])).expect(200)).body;
    expect(info).toMatchObject({ clientName: 'Claude', redirectHost: 'localhost:9999' });
    const decided = (await api().post('/ai/mcp/requests/decide').set(auth(companyId, ['usar_mcp'])).send({ pedido, approve: true }).expect(200)).body;
    const back = new URL(decided.redirectUrl);
    expect(back.searchParams.get('state')).toBe('abc123');
    const tokens = (await api().post('/token').type('form').send({ grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: registered.client_id, redirect_uri: REDIRECT }).expect(200)).body;
    expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    return { client: registered, tokens, pedido, code: back.searchParams.get('code')!, verifier };
  }

  it('publica os metadados do OAuth e exige token no /mcp', async () => {
    const meta = (await api().get('/.well-known/oauth-authorization-server').expect(200)).body;
    expect(meta).toMatchObject({ authorization_endpoint: expect.stringContaining('/authorize'), token_endpoint: expect.stringContaining('/token'), code_challenge_methods_supported: ['S256'] });
    const resource = (await api().get('/.well-known/oauth-protected-resource/mcp').expect(200)).body;
    expect(resource.resource).toContain('/mcp');
    const denied = await api().post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
    expect(denied.headers['www-authenticate']).toContain('resource_metadata');
  });

  it('conexão completa: aprovar, usar ferramentas e ação pendente', async () => {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    await grant(userId, ['usar_mcp', 'list_classes', 'update_classes']);
    const course = await makeCourse(company.id);
    const turma = await makeCourseClass(company.id, course.id, { name: 'NR-33 Espaço confinado', initialDate: new Date(Date.now() + 5 * 86400000), finalDate: new Date(Date.now() + 6 * 86400000), openClass: false });
    const { tokens, code, verifier, client } = await connect(company.id);

    // o código vale uma vez só
    await api().post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }).expect(400);

    const init = (await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } }).expect(200)).body;
    expect(init.result.serverInfo.name).toBe('worksafe');
    const list = (await rpc(tokens.access_token, 'tools/list').expect(200)).body;
    const names = list.result.tools.map((tool: any) => tool.name).sort();
    // só o que as permissões da pessoa liberam
    expect(names).toEqual(['buscar_aluno', 'definir_imagem', 'enviar_imagem_base64', 'enviar_imagem_por_url', 'imagens_do_envio', 'link_para_enviar_imagens', 'listar_inscritos', 'listar_turmas', 'minha_esteira', 'publicar_turma', 'vincular_empresa_inscricao']);

    const called = (await rpc(tokens.access_token, 'tools/call', { name: 'listar_turmas', arguments: {} }).expect(200)).body;
    expect(JSON.parse(called.result.content[0].text).turmas[0]).toMatchObject({ nome: 'NR-33 Espaço confinado', abertaNoSite: false });

    const pending = (await rpc(tokens.access_token, 'tools/call', { name: 'publicar_turma', arguments: { turmaId: turma.id } }).expect(200)).body;
    const out = JSON.parse(pending.result.content[0].text);
    expect(out).toMatchObject({ situacao: 'aguardando_confirmacao', instrucao: expect.stringContaining('Ações pendentes') });
    expect((await testDb().courseClass.findUnique({ where: { id: turma.id } }))!.openClass).toBe(false);
    // ferramenta fora da permissão: nem existe para ele
    const denied = (await rpc(tokens.access_token, 'tools/call', { name: 'criar_rascunho_post_blog', arguments: { titulo: 'x', conteudo: 'y' } }).expect(200)).body;
    expect(denied.result.isError).toBe(true);

    const audit = await testDb().ai_ToolCall.findMany({ orderBy: { id: 'asc' } });
    expect(audit.map((row) => [row.origin, row.tool, row.status])).toEqual([['mcp', 'listar_turmas', 'ok'], ['mcp', 'publicar_turma', 'pending'], ['mcp', 'criar_rascunho_post_blog', 'denied']]);

    // confirmar no sistema
    const [action] = (await api().get('/ai/actions').set(auth(company.id, ['usar_mcp', 'update_classes'])).expect(200)).body;
    await api().post(`/ai/actions/${action.id}/confirm`).set(auth(company.id, ['usar_mcp', 'update_classes'])).expect(200);
    expect((await testDb().courseClass.findUnique({ where: { id: turma.id } }))!.openClass).toBe(true);
  });

  it('tirar a permissão vale na hora; revogar e renovar o token', async () => {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    await grant(userId, ['usar_mcp']);
    const { tokens, client } = await connect(company.id);
    await rpc(tokens.access_token, 'tools/list').expect(200);

    // renovação gira o par
    const renewed = (await api().post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }).expect(200)).body;
    await api().post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }).expect(400);
    await rpc(tokens.access_token, 'tools/list').expect(401);
    await rpc(renewed.access_token, 'tools/list').expect(200);

    await testDb().userPermission.updateMany({ where: { userId }, data: { inactiveAt: new Date() } });
    await rpc(renewed.access_token, 'tools/list').expect(403);
    await testDb().userPermission.updateMany({ where: { userId }, data: { inactiveAt: null } });

    const connections = (await api().get('/ai/mcp/connections').set(auth(company.id, ['usar_mcp'])).expect(200)).body;
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ client: 'Claude', mine: true });
    await api().patch(`/ai/mcp/connections/${connections[0].id}/revoke`).set(auth(company.id, ['usar_mcp'])).expect(200);
    await rpc(renewed.access_token, 'tools/list').expect(401);

    // desligado
    const again = await connect(company.id);
    process.env.MCP_ENABLED = 'false';
    await rpc(again.tokens.access_token, 'tools/list').expect(503);
  });

  it('sem usar_mcp não aprova; recusar devolve access_denied; pedido usado não volta', async () => {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const registered = (await api().post('/register').send({ client_name: 'App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).expect(201)).body;
    const challenge = createHash('sha256').update('v'.repeat(43)).digest('base64url');
    const go = async () => new URL((await api().get('/authorize').query({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }).expect(302)).headers.location).searchParams.get('pedido')!;
    const pedido = await go();
    await api().post('/ai/mcp/requests/decide').set(auth(company.id, ['usar_bots'])).send({ pedido, approve: true }).expect(403);
    const refused = (await api().post('/ai/mcp/requests/decide').set(auth(company.id, [])).send({ pedido, approve: false }).expect(200)).body;
    expect(new URL(refused.redirectUrl).searchParams.get('error')).toBe('access_denied');
    await api().get('/ai/mcp/requests').query({ pedido }).set(auth(company.id, ['usar_mcp'])).expect(404);
    // redirect que não foi registrado é recusado pelo próprio servidor OAuth
    await api().get('/authorize').query({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' }).expect(400);
  });
});
