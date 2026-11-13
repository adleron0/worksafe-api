import './setup/env'; // precisa ser o primeiro import

import { bootTestApp, shutdownTestApp } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { PostService } from 'src/features/blog/post/service';

/**
 * Visualização não é edição. O incremento de viewCount passava pelo
 * Prisma Client e o `@updatedAt` mudava a cada visita — o site mostrava
 * "Atualizado em" e o sitemap informava lastmod falsos.
 */
describe('Blog: contagem de visualizações (e2e)', () => {
  let posts: PostService;

  beforeAll(async () => {
    const app = await bootTestApp();
    posts = app.get(PostService);
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDb();
  });

  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  async function makePost(slug: string) {
    const company = await makeCompany();
    const author = await makeSeller(company.id);
    const editedAt = new Date('2026-07-24T14:07:49.000Z');
    const post = await testDb().blog_Post.create({
      data: {
        companyId: company.id,
        authorId: author.id,
        title: 'Post de teste',
        slug,
        content: '<p>conteúdo</p>',
        status: 'published',
        publishedAt: editedAt,
        updatedAt: editedAt,
      },
    });
    return { company, post, editedAt };
  }
  const views = async (id: number) =>
    (await testDb().blog_Post.findUniqueOrThrow({ where: { id } })).viewCount;

  it('leitura real incrementa viewCount e preserva updatedAt', async () => {
    const { company, post, editedAt } = await makePost(`post-${Date.now()}-a`);

    const r = await posts.registerView(company.id, post.slug, { userAgent: UA, ip: '203.0.113.10' });

    expect(r).toEqual({ counted: true });
    const after = await testDb().blog_Post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.viewCount).toBe(1);
    expect(after.updatedAt.toISOString()).toBe(editedAt.toISOString());
  });

  it('buscar o post (SSR) não conta visualização', async () => {
    const { company, post } = await makePost(`post-${Date.now()}-b`);
    await posts.findBySlug(company.id, post.slug);
    await posts.findBySlug(company.id, post.slug);
    expect(await views(post.id)).toBe(0);
  });

  it('robôs, prévias de link e clientes HTTP não contam', async () => {
    const { company, post } = await makePost(`post-${Date.now()}-c`);
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0) Chrome/116 Safari/537.36',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'WhatsApp/2.23.20.0',
      'curl/8.4.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36',
      '',
      undefined,
    ];
    for (const userAgent of bots) {
      const r = await posts.registerView(company.id, post.slug, { userAgent, ip: '203.0.113.11' });
      expect(r).toEqual({ counted: false, reason: 'bot' });
    }
    expect(await views(post.id)).toBe(0);
  });

  it('mesmo visitante relendo conta uma vez; outro visitante conta de novo', async () => {
    const { company, post } = await makePost(`post-${Date.now()}-d`);
    await posts.registerView(company.id, post.slug, { userAgent: UA, ip: '203.0.113.12' });
    const again = await posts.registerView(company.id, post.slug, { userAgent: UA, ip: '203.0.113.12' });
    expect(again).toEqual({ counted: false, reason: 'repeat' });
    await posts.registerView(company.id, post.slug, { userAgent: UA, ip: '203.0.113.13' });
    expect(await views(post.id)).toBe(2);
  });
});
