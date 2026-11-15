import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as sharp from 'sharp';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Imagens pelos bots e pelo MCP: link de envio (a pessoa arrasta no WorkSafe),
 * URL pública (com proteção contra rede interna), base64, e o uso no post e
 * na turma. Só imagens do próprio sistema vão para o site.
 */
describe('Imagens pelos bots e MCP (e2e)', () => {
  const PERMS = ['usar_mcp', 'create_blog', 'update_blog', 'create_classes', 'update_classes', 'list_classes'];
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;
  let png: Buffer;

  beforeAll(async () => {
    process.env.PUBLIC_IMAGES_DRIVER = 'memory';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
    png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 120, b: 60 } } }).png().toBuffer();
  });
  afterAll(async () => { delete process.env.PUBLIC_IMAGES_DRIVER; nock.cleanAll(); await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = PERMS) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  async function cenario(permissions = PERMS) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const ctx: ToolContext = { userId, companyId: company.id, permissions, origin: 'mcp' };
    const call = async (tool: string, input: Record<string, unknown>) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    return { company, ctx, call, db: testDb() };
  }

  it('link de envio: a pessoa sobe pela página pública e o assistente pega as URLs', async () => {
    const { company, call, db } = await cenario();
    const link = await call('link_para_enviar_imagens', { finalidade: 'Capa do post sobre NR-35', quantidade: 2 });
    expect(link.status).toBe('ok');
    expect(link.data.link).toMatch(/\/enviar-imagens\?t=[A-Za-z0-9_-]+$/);
    const token = new URL(link.data.link).searchParams.get('t')!;

    const info = (await api().get(`/ai/upload-links/${token}`).expect(200)).body;
    expect(info).toMatchObject({ purpose: 'Capa do post sobre NR-35', company: 'WorkSafe Teste', maxFiles: 2, expired: false, images: [] });
    await api().get('/ai/upload-links/token-que-nao-existe-de-jeito-nenhum').expect(404);

    const up = (await api().post(`/ai/upload-links/${token}/images`).attach('files', png, 'foto da turma.png').expect(201)).body;
    expect(up.images[0]).toMatchObject({ name: 'foto da turma.png', width: 64, height: 48, url: expect.stringMatching(/^https:\/\/imagens\.teste\.local\/ia-imagens\//) });
    // não é imagem
    await api().post(`/ai/upload-links/${token}/images`).attach('files', Buffer.from('não sou imagem'), 'x.png').expect(400);
    // passa do limite do link
    await api().post(`/ai/upload-links/${token}/images`).attach('files', png, 'a.png').attach('files', png, 'b.png').expect(400);

    const got = await call('imagens_do_envio', { envioId: link.data.envioId });
    expect(got.data.imagens).toHaveLength(1);
    expect(got.data.imagens[0].url).toBe(up.images[0].url);
    // entrou na galeria de imagens da empresa
    expect(await db.image.count({ where: { companyId: company.id } })).toBe(1);

    // expirado não aceita mais
    await db.ai_UploadLink.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post(`/ai/upload-links/${token}/images`).attach('files', png, 'c.png').expect(400);
  });

  it('por URL (sem rede interna) e por base64', async () => {
    const { call } = await cenario();
    for (const url of ['http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.5/a.png', 'https://[::1]/a.png', 'nada']) {
      const out = await call('enviar_imagem_por_url', { url });
      expect(out.status).toBe('refused');
    }
    nock('https://example.com').get('/foto.png').reply(200, png, { 'Content-Type': 'image/png' });
    const byUrl = await call('enviar_imagem_por_url', { url: 'https://example.com/foto.png' });
    expect(byUrl.status).toBe('ok');
    expect(byUrl.data).toMatchObject({ nome: 'foto.png', largura: 64 });
    nock('https://example.com').get('/pagina').reply(200, '<html></html>', { 'Content-Type': 'text/html' });
    expect((await call('enviar_imagem_por_url', { url: 'https://example.com/pagina' })).status).toBe('refused');

    const b64 = await call('enviar_imagem_base64', { base64: `data:image/png;base64,${png.toString('base64')}`, nome: 'arte' });
    expect(b64.data).toMatchObject({ nome: 'arte', altura: 48 });
    expect((await call('enviar_imagem_base64', { base64: 'isso não é base64!' })).status).toBe('refused');
  });

  it('usa só imagem do sistema no post e na turma, e trocar imagem pede confirmação', async () => {
    const { company, call, db } = await cenario();
    const image = (await call('enviar_imagem_base64', { base64: png.toString('base64'), nome: 'capa' })).data;
    const longText = '<p>' + 'Texto do post sobre trabalho em altura. '.repeat(10) + '</p>';
    expect((await call('criar_rascunho_post_blog', { titulo: 'Post com capa externa', conteudo: longText, capaUrl: 'https://outro.site/capa.png' })).status).toBe('refused');
    const post = await call('criar_rascunho_post_blog', {
      titulo: 'Cinto paraquedista: inspeção', capaUrl: image.url,
      conteudo: `${longText}<img src="${image.url}" alt="Cinto" onerror="alert(1)"><img src="https://rastreio.site/p.gif">`,
    });
    expect(post.status).toBe('ok');
    const saved = await db.blog_Post.findUnique({ where: { id: post.data.id } });
    expect(saved).toMatchObject({ coverImage: image.url, status: 'draft' });
    expect(saved!.content).toContain(`<img src="${image.url}" alt="Cinto">`);
    expect(saved!.content).not.toContain('rastreio.site');
    expect(saved!.content).not.toContain('onerror');

    const course = await makeCourse(company.id);
    const turma = await makeCourseClass(company.id, course.id, { name: 'NR-35', imageUrl: null });
    const pending = await call('definir_imagem', { alvo: 'turma', id: turma.id, imagemUrl: image.url });
    expect(pending.status).toBe('pending');
    expect((await db.courseClass.findUnique({ where: { id: turma.id } }))!.imageUrl).toBeNull();
    expect((await call('definir_imagem', { alvo: 'turma', id: turma.id, imagemUrl: 'https://outro.site/x.png' })).status).toBe('refused');
    await api().post(`/ai/actions/${pending.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect((await db.courseClass.findUnique({ where: { id: turma.id } }))!.imageUrl).toBe(image.url);
  });

  it('sem permissão de blog ou turmas não sobe imagem', async () => {
    const { call } = await cenario(['usar_mcp', 'list_classes']);
    expect((await call('link_para_enviar_imagens', { finalidade: 'x' })).status).toBe('denied');
    expect(catalog.visible(null, ['usar_mcp', 'list_classes']).map((tool) => tool.name)).not.toContain('enviar_imagem_por_url');
  });
});
