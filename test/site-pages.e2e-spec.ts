import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse } from './setup/factories';
import { slugField, toSlug } from 'src/common/crud/hooks';

/**
 * Páginas de serviço e de curso no site (/servicos/:slug e /cursos/:slug).
 * O texto, o slug e o SEO vêm do cadastro; o site só acha o item pelo slug.
 */
describe('Site: páginas de serviço e de curso (e2e)', () => {
  beforeAll(async () => {
    await bootTestApp();
  });
  afterAll(async () => {
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
  });

  it('slug sai normalizado do nome digitado; vazio vira null', () => {
    expect(toSlug('  Alpinismo Industrial em Recife/PE ')).toBe('alpinismo-industrial-em-recife-pe');
    expect(toSlug('Espaços Confinados — NR-33')).toBe('espacos-confinados-nr-33');
    const hook = slugField().preWrite as (ctx: any) => any;
    expect(hook({ data: { slug: 'Resgate Industrial' } }).slug).toBe('resgate-industrial');
    expect(hook({ data: { slug: '' } }).slug).toBeNull();
    expect(hook({ data: { name: 'sem slug' } })).toEqual({ name: 'sem slug' });
  });

  it('serviço público pode ser buscado pelo slug, com texto, SEO e FAQ', async () => {
    const company = await makeCompany({ lp_domain: 'site.local' });
    await testDb().site_Services.create({
      data: {
        companyId: company.id,
        name: 'Alpinismo Industrial',
        slug: 'alpinismo-industrial',
        description: 'Resumo',
        content: '<p>Texto</p>',
        seoTitle: 'Alpinismo industrial em Recife',
        seoDescription: 'Descrição',
        faq: [{ question: 'P?', answer: 'R.' }],
      },
    });
    await testDb().site_Services.create({ data: { companyId: company.id, name: 'Outro', slug: 'outro' } });

    const res = await request(httpServer())
      .get('/site-services')
      .query({ slug: 'alpinismo-industrial', active: true, limit: 10 })
      .expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      slug: 'alpinismo-industrial',
      content: '<p>Texto</p>',
      seoTitle: 'Alpinismo industrial em Recife',
      faq: [{ question: 'P?', answer: 'R.' }],
    });
  });

  it('lista pública de cursos traz a página do curso e nunca o gabarito da prova', async () => {
    const company = await makeCompany({ lp_domain: 'site.local' });
    const course = await makeCourse(company.id);
    await testDb().course.update({
      where: { id: course.id },
      data: {
        slug: 'acesso-por-corda',
        content: '<p>Curso</p>',
        seoTitle: 'Curso de acesso por corda',
        exam: [{ question: 'Q', options: [{ text: 'A', isCorrect: true }] }],
      },
    });

    const res = await request(httpServer()).get('/courses/list').query({ lp_domain: 'site.local' }).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ slug: 'acesso-por-corda', content: '<p>Curso</p>', seoTitle: 'Curso de acesso por corda' });
    expect(res.body[0]).not.toHaveProperty('exam');
  });

  it('o mesmo slug não se repete na mesma empresa', async () => {
    const company = await makeCompany();
    await testDb().site_Services.create({ data: { companyId: company.id, name: 'A', slug: 'repetido' } });
    await expect(
      testDb().site_Services.create({ data: { companyId: company.id, name: 'B', slug: 'repetido' } }),
    ).rejects.toThrow();
  });
});
