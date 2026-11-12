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
describe('Blog: visualização não altera updatedAt (e2e)', () => {
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

  it('incrementa viewCount e preserva updatedAt', async () => {
    const company = await makeCompany();
    const author = await makeSeller(company.id);
    const editedAt = new Date('2026-07-24T14:07:49.000Z');
    const post = await testDb().blog_Post.create({
      data: {
        companyId: company.id,
        authorId: author.id,
        title: 'Post de teste',
        slug: 'post-de-teste',
        content: '<p>conteúdo</p>',
        status: 'published',
        publishedAt: editedAt,
        updatedAt: editedAt,
      },
    });

    await posts.findBySlugAndIncrementViews(company.id, 'post-de-teste');
    await posts.incrementViews(post.id); // o da rota roda em background

    const after = await testDb().blog_Post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.viewCount).toBeGreaterThanOrEqual(1);
    expect(after.updatedAt.toISOString()).toBe(editedAt.toISOString());
  });
});
