import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass } from './setup/factories';

/**
 * Contrato do worksafe-site com a API. O site monta a query em
 * src/services/api.ts: `show` em CSV, `or` como JSON e a empresa escolhida por
 * `company.lp_domain`. O deploy de 11/11/2026 quebrou o site inteiro porque a
 * API nova recusava esses filtros com 400.
 */
describe('Contrato do site público (e2e)', () => {
  beforeAll(async () => {
    await bootTestApp();
  });
  afterAll(async () => {
    await shutdownTestApp();
  });

  let ids: { mine: number[]; other: number };
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    const mine = await makeCompany({ lp_domain: 'site.local' });
    const other = await makeCompany({ lp_domain: 'outro.local' });
    const c1 = await makeCourse(mine.id);
    const c2 = await makeCourse(other.id);
    const future = await makeCourseClass(mine.id, c1.id, { openClass: true, periodClass: 'LIMITED', initialDate: new Date(Date.now() + 7 * 864e5) });
    const unlimited = await makeCourseClass(mine.id, c1.id, { openClass: true, periodClass: 'UNLIMITED', initialDate: new Date(Date.now() - 30 * 864e5) });
    await makeCourseClass(mine.id, c1.id, { openClass: true, periodClass: 'LIMITED', initialDate: new Date(Date.now() - 30 * 864e5) });
    const otherClass = await makeCourseClass(other.id, c2.id, { openClass: true, periodClass: 'UNLIMITED' });
    ids = { mine: [future.id, unlimited.id], other: otherClass.id };
  });

  it('home: or em JSON + company.lp_domain + show CSV', async () => {
    const today = new Date().toISOString().split('T')[0];
    const or = JSON.stringify([{ 'gte-initialDate': today }, { periodClass: 'UNLIMITED' }]);
    const res = await request(httpServer())
      .get('/classes')
      .query({ limit: 999, show: '_count', openClass: true, 'company.lp_domain': 'site.local', or })
      .expect(200);
    expect(res.body.rows.map((r: any) => r.id).sort()).toEqual([...ids.mine].sort());
  });

  it('página da turma: filtro por id com show CSV', async () => {
    const res = await request(httpServer())
      .get('/classes')
      .query({ id: ids.mine[0], show: 'course,instructors,_count', openClass: true })
      .expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].course).toBeDefined();
  });

  it('or em JSON malformado é recusado com 400, nunca avaliado', async () => {
    await request(httpServer()).get('/classes').query({ or: '[{"periodClass":' }).expect(400);
  });

  it('blog: categorias, tags e posts aceitam company.lp_domain', async () => {
    for (const path of ['/blog/categories/public', '/blog/tags/public', '/blog/posts/public']) {
      await request(httpServer()).get(path).query({ 'company.lp_domain': 'site.local' }).expect(200);
    }
  });
});
