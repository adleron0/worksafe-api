// E2E local: feat/crud-core (3100) vs main (3101), mesmo banco worksafe_e2e.
// Uso: node e2e.mjs   (lê e2e.env do mesmo diretório)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, 'e2e.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const NEW = 'http://localhost:3100';
const OLD = 'http://localhost:3101';

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });

async function req(base, method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = new FormData();
    for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) payload.append(k, String(v));
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function login(base, email) {
  const r = await req(base, 'POST', '/auth/login', { body: { email, password: env.PASS, cnpj: env.CNPJ } });
  return r.json?.accessToken;
}

const qs = (o) => '?' + new URLSearchParams(o).toString();

// ─────────────────────────────────────────────── 1. auth
// Login sequencial com intervalo: dois logins do mesmo usuário no mesmo segundo
// geram o mesmo refresh token e violam a unique de Session (bug pré-existente).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = {};
tok.newSuper = await login(NEW, env.E_SUPER); await sleep(1100);
tok.oldSuper = await login(OLD, env.E_SUPER);
tok.newAdmin = await login(NEW, env.E_ADMIN);
tok.newTreino = await login(NEW, env.E_TREINO);
ok('login super (novo)', tok.newSuper);
ok('login super (antigo)', tok.oldSuper);
ok('login admin (novo)', tok.newAdmin);
ok('login treinamento (novo)', tok.newTreino);

// ─────────────────────────────────────────────── 2. paridade de listagem
const LISTS = [
  'customer', 'ranks', 'roles', 'states', 'cities', 'site-services', 'site-products', 'site_productsimages',
  'instructors', 'coupon', 'blog/tags', 'blog/categories', 'blog/posts', 'blog/comments', 'blog/visitors',
  'user', 'profiles', 'customer-contacts', 'images', 'companies', 'class-instructors', 'reviews', 'courses',
  'trainee', 'exames', 'certificate', 'attendance-list', 'online-courses', 'online-lesson', 'online-lesson-step',
  'online-course-lesson', 'classes', 'subscription', 'trainee-certificate', 'company-gateways',
  'financial-records', 'splits-transactions',
];
const parity = [];
for (const route of LISTS) {
  const q = qs({ limit: 'all' });
  const [n, o] = await Promise.all([
    req(NEW, 'GET', `/${route}${q}`, { token: tok.newSuper }),
    req(OLD, 'GET', `/${route}${q}`, { token: tok.oldSuper }),
  ]);
  const ids = (r) => (Array.isArray(r.json?.rows) ? r.json.rows.map((x) => x.id).sort((a, b) => a - b) : null);
  const nIds = ids(n), oIds = ids(o);
  const sameIds = JSON.stringify(nIds) === JSON.stringify(oIds);
  const keys = (r) => new Set(Object.keys(r.json?.rows?.[0] ?? {}));
  const nk = keys(n), okk = keys(o);
  const onlyOld = [...okk].filter((k) => !nk.has(k));
  const onlyNew = [...nk].filter((k) => !okk.has(k));
  parity.push({ route, new: n.status, old: o.status, nTotal: n.json?.total, oTotal: o.json?.total, sameIds, onlyOld, onlyNew,
    err: n.status >= 400 ? (n.json?.message ?? n.json) : undefined });
}

// ─────────────────────────────────────────────── 3. rotas públicas (sem token)
const pub = [
  ['GET', '/classes' + qs({ limit: 'all' }), 200],
  ['GET', '/states' + qs({ limit: 'all', 'order-name': 'asc' }), 200],
  ['GET', '/cities' + qs({ limit: 'all', stateId: '25', 'order-name': 'asc' }), 200],
  ['GET', '/site-services' + qs({ limit: '999', active: 'true', 'order-name': 'asc' }), 200],
  ['GET', '/site-products' + qs({ limit: 'all' }), 200],
  ['GET', '/blog/posts/public' + qs({ companyId: '1' }), 200],
  ['GET', '/blog/tags/public' + qs({ companyId: '1' }), 200],
  ['GET', '/blog/categories/public' + qs({ companyId: '1' }), 200],
  ['GET', '/blog/comments/public' + qs({ companyId: '1', postId: '1' }), 200],
  ['GET', '/trainee-certificate/public' + qs({ companyId: '1', limit: '10' }), 200],
  ['GET', '/companies/public' + qs(env.LP_DOMAIN ? { lp_domain: env.LP_DOMAIN } : { limit: '1' }), 200],
  ['GET', '/courses/list' + qs({ companyId: '1' }), 200],
  ['POST', '/webhooks/asaas/1', 401],
  ['GET', '/customer', 401],
  ['GET', '/user', 401],
];
for (const [m, p, expected] of pub) {
  const r = await req(NEW, m, p, m === 'POST' ? { body: { event: 'PAYMENT_CONFIRMED' } } : {});
  ok(`público ${m} ${p.split('?')[0]} → ${expected}`, r.status === expected, `veio ${r.status} ${typeof r.json === 'object' ? JSON.stringify(r.json).slice(0, 140) : ''}`);
}
{
  const r = await req(NEW, 'GET', '/companies/public' + qs({ limit: '5' }));
  const leaked = (r.json?.rows ?? []).some((c) => 'financial_email' in c || 'email_conection' in c || 'id' in c);
  ok('vitrine da empresa não expõe id/financeiro/SMTP', r.status === 200 && !leaked, JSON.stringify(Object.keys(r.json?.rows?.[0] ?? {})).slice(0, 200));
  const pubCert = await req(NEW, 'GET', '/trainee-certificate/public' + qs({ companyId: '1', showOnWebsiteConsent: 'false', limit: 'all' }));
  ok('vitrine de certificados ignora showOnWebsiteConsent=false do cliente', pubCert.status === 400 || (pubCert.json?.rows ?? []).every((c) => c.showOnWebsiteConsent !== false), `status ${pubCert.status}`);
}

// ─────────────────────────────────────────────── 4. contratos que o front usa
const front = [
  ['customer (order-name + show)', '/customer' + qs({ limit: '10', page: '0', 'order-name': 'asc', show: 'rank,state,city' })],
  ['customer like-name', '/customer' + qs({ 'like-name': 'a', limit: '10' })],
  ['customer active=true', '/customer' + qs({ active: 'true', limit: 'all' })],
  ['financial-records -aggregate (recebíveis)', '/financial-records' + qs({ '-aggregate': 'status:count:sum:value', limit: '10' })],
  ['online-lesson OR (formato novo or.N)', '/online-lesson' + qs({ 'or.0.courseId': '1', 'or.1.null-courseId': 'true', limit: 'all', active: 'true' })],
  ['subscription show=class,trainee', '/subscription' + qs({ show: 'class,trainee', limit: '10' })],
  ['trainee-certificate admin like-trainee.name', '/trainee-certificate' + qs({ show: 'trainee', 'like-trainee.name': 'a', limit: '10' })],
  ['blog/posts show completo', '/blog/posts' + qs({ show: '[author,category,tags,_count]', limit: '10' })],
  ['user show permissions', '/user' + qs({ show: 'profile,permissions', limit: '10' })],
  ['classes order-initialDate', '/classes' + qs({ 'order-initialDate': 'desc', limit: '10' })],
  ['coupon _count', '/coupon' + qs({ show: 'seller,class,course,_count', limit: '10' })],
];
for (const [name, path] of front) {
  const r = await req(NEW, 'GET', path, { token: tok.newSuper });
  ok(`front: ${name}`, r.status === 200, r.status !== 200 ? `${r.status} ${JSON.stringify(r.json).slice(0, 200)}` : `total=${r.json?.total}${r.json?.aggregations ? ' agg=' + JSON.stringify(r.json.aggregations).slice(0, 80) : ''}`);
}

{
  const legacy = await req(NEW, 'GET', '/online-lesson' + qs({ or: '[{ "courseId": 1 }]' }), { token: tok.newSuper });
  ok('or em JSON (formato antigo) é recusado com 400 — corte decidido, front migrado', legacy.status === 400, `${legacy.status}`);
  const all = await req(NEW, 'GET', '/customer' + qs({ limit: 'all' }), { token: tok.newSuper });
  const nl = await req(NEW, 'GET', '/customer' + qs({ 'notlike-name': 'zzz', limit: 'all' }), { token: tok.newSuper });
  const nl2 = await req(NEW, 'GET', '/customer' + qs({ 'notlike-name': (all.json?.rows?.[0]?.name ?? 'x'), limit: 'all' }), { token: tok.newSuper });
  ok('notlike- funciona (nunca funcionou no generic antigo)', nl.status === 200 && nl.json?.total === all.json?.total && nl2.json?.total < all.json?.total,
    `${nl.status} total=${nl.json?.total}/${all.json?.total} excl=${nl2.json?.total}`);
}

// ─────────────────────────────────────────────── 4b. escrita por id em várias entidades (multipart, valores iguais)
const firstRow = async (route) => (await req(NEW, 'GET', `/${route}` + qs({ limit: '1' }), { token: tok.newSuper })).json?.rows?.[0];
for (const [route, field] of [['classes', 'name'], ['instructors', 'name'], ['coupon', 'description'], ['courses', 'name'],
  ['site-services', 'name'], ['blog/categories', 'name'], ['customer-contacts', 'name'], ['certificate', 'name'],
  ['online-lesson', 'title'], ['profiles', 'name'], ['user', 'name']]) {
  const row = await firstRow(route);
  if (!row) { ok(`PUT /${route}/:id`, false, 'sem registro'); continue; }
  const r = await req(NEW, 'PUT', `/${route}/${row.id}`, { token: tok.newSuper, form: { [field]: row[field] ?? 'x' } });
  ok(`PUT /${route}/:id (multipart)`, r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 180)}`);
}
{
  const post = await firstRow('blog/posts');
  const pub = await req(NEW, 'PATCH', `/blog/posts/publish/${post.id}`, { token: tok.newSuper });
  ok('PATCH /blog/posts/publish/:id', pub.status === 200 && pub.json?.status === 'published', `${pub.status} ${JSON.stringify(pub.json).slice(0, 160)}`);
  const com = await firstRow('blog/comments');
  const mod = await req(NEW, 'PATCH', `/blog/comments/approve/${com.id}`, { token: tok.newSuper });
  ok('PATCH /blog/comments/approve/:id', mod.status === 200, `${mod.status} ${JSON.stringify(mod.json).slice(0, 160)}`);
  const sub = await firstRow('subscription');
  const su = await req(NEW, 'PUT', `/subscription/${sub.id}`, { token: tok.newSuper, form: { occupation: sub.occupation ?? 'x' } });
  ok('PUT /subscription/:id', su.status === 200, `${su.status} ${JSON.stringify(su.json).slice(0, 160)}`);
}

{
  // evicção: vitrine cacheada 48h precisa refletir a edição imediatamente
  const before = await req(NEW, 'GET', '/site-services' + qs({ limit: '999', 'order-name': 'asc' }));
  const svc = before.json?.rows?.[0];
  const novo = (svc?.name ?? 'x').replace(/ \(e2e\d+\)$/, '') + ` (e2e${Date.now() % 1000})`;
  await req(NEW, 'PUT', `/site-services/${svc.id}`, { token: tok.newSuper, form: { name: novo } });
  const after = await req(NEW, 'GET', '/site-services' + qs({ limit: '999', 'order-name': 'asc' }));
  ok('evicção de cache: vitrine reflete a edição', after.json?.rows?.some((r) => r.name === novo), `cache=${after.json ? 'resp' : '-'}`);
}

// ─────────────────────────────────────────────── 5. escrita + segurança
{
  const cnpj = String(Date.now()).slice(-14).padStart(14, '9');
  const c = await req(NEW, 'POST', '/customer', { token: tok.newSuper, form: {
    name: 'E2E Cliente', corporateName: 'E2E Cliente Ltda', cnpj, rankId: 1, phone: '11999999999',
    email: 'e2e@example.com', stateId: 25, cityId: 1, description: 'teste e2e' } });
  ok('cria cliente', c.status === 201 || c.status === 200, `${c.status} ${JSON.stringify(c.json).slice(0, 200)}`);
  const id = c.json?.id;
  if (id) {
    const u = await req(NEW, 'PUT', `/customer/${id}`, { token: tok.newSuper, form: { name: 'E2E Cliente 2' } });
    ok('atualiza cliente', u.status === 200 && u.json?.name === 'E2E Cliente 2', `${u.status}`);
    const mass = await req(NEW, 'PUT', `/customer/${id}`, { token: tok.newSuper, form: { companyId: 2 } });
    ok('mass-assignment companyId → 400 com campo', mass.status === 400 && mass.json?.field === 'companyId', `${mass.status} ${JSON.stringify(mass.json)}`);
    const a = await req(NEW, 'PATCH', `/customer/inactive/${id}`, { token: tok.newSuper });
    ok('arquiva cliente (active=false + inactiveAt)', a.status === 200 && a.json?.active === false && a.json?.inactiveAt, `${a.status} ${JSON.stringify(a.json).slice(0, 120)}`);
    const r2 = await req(NEW, 'PATCH', `/customer/active/${id}`, { token: tok.newSuper });
    ok('restaura cliente', r2.status === 200 && r2.json?.active === true && r2.json?.inactiveAt === null, `${r2.status}`);
    const dup = await req(NEW, 'POST', '/customer', { token: tok.newSuper, form: {
      name: 'Dup', corporateName: 'Dup', cnpj, rankId: 1, phone: '1', email: 'd@example.com', stateId: 25, cityId: 1 } });
    ok('cnpj duplicado → 409', dup.status === 409, `${dup.status} ${JSON.stringify(dup.json).slice(0, 120)}`);
    const logs = await req(NEW, 'GET', '/customer/' + id, { token: tok.newSuper });
    ok('getById cliente', logs.status === 200);
  }
  const self = await req(NEW, 'GET', '/user/self', { token: tok.newAdmin });
  ok('GET /user/self devolve objeto sem password', self.status === 200 && self.json?.id && !('password' in self.json), `${self.status}`);
  const esc = await req(NEW, 'PUT', '/user/self', { token: tok.newAdmin, form: { profileId: 1 } });
  ok('PUT /user/self com profileId → 400', esc.status === 400, `${esc.status} ${JSON.stringify(esc.json)}`);
  const leak = await req(NEW, 'GET', '/user' + qs({ 'omitAttributes[]': 'id', limit: '5' }), { token: tok.newSuper });
  ok('GET /user nunca devolve password', leak.status !== 200 || !(leak.json?.rows ?? []).some((u) => 'password' in u), `${leak.status}`);
  const filt = await req(NEW, 'GET', '/user' + qs({ password: 'x' }), { token: tok.newSuper });
  ok('filtro por coluna fora da allowlist → 400', filt.status === 400, `${filt.status}`);
  const evil = await req(NEW, 'GET', '/classes' + qs({ or: 'process.exit(1)' }));
  ok('or malicioso não executa (API segue viva)', evil.status === 400 && (await req(NEW, 'GET', '/states')).status === 200, `${evil.status}`);
}

// ─────────────────────────────────────────────── 6. perfil restrito (treinamento)
{
  const r1 = await req(NEW, 'GET', '/classes' + qs({ limit: '5' }), { token: tok.newTreino });
  ok('treinamento lista turmas', r1.status === 200, `${r1.status}`);
  const r2 = await req(NEW, 'GET', '/company-gateways', { token: tok.newTreino });
  ok('treinamento sem acesso a integrações → 403', r2.status === 403, `${r2.status}`);
  const r3 = await req(NEW, 'GET', '/ranks' + qs({ limit: 'all' }), { token: tok.newTreino });
  ok('ranks listável por qualquer autenticado (dropdown)', r3.status === 200, `${r3.status}`);
}

// ─────────────────────────────────────────────── 7. aluno
{
  const lg = await req(NEW, 'POST', '/auth/student/login', { body: { credential: env.T_CPF, password: env.PASS } });
  const st = lg.json?.accessToken;
  ok('login aluno', st, `${lg.status}`);
  if (st) {
    const me = await req(NEW, 'GET', '/student', { token: st });
    ok('GET /student só o próprio', me.status === 200 && me.json?.total === 1 && me.json.rows[0].id === Number(env.T_ID) && !('password' in me.json.rows[0]), `${me.status} total=${me.json?.total}`);
    const other = await req(NEW, 'PUT', `/student/${Number(env.T_ID) + 1}`, { token: st, form: { name: 'hack' } });
    ok('aluno não edita outro aluno → 404', other.status === 404, `${other.status}`);
    const mc = await req(NEW, 'GET', '/student-courses/my-courses', { token: st });
    ok('GET /student-courses/my-courses', mc.status === 200, `${mc.status}`);
    const sc = await req(NEW, 'GET', '/student-courses' + qs({ limit: '10' }), { token: st });
    ok('GET /student-courses (só do aluno)', sc.status === 200 && (sc.json?.rows ?? []).every((x) => x.traineeId === Number(env.T_ID)), `${sc.status}`);
    const upd = await req(NEW, 'PUT', `/student/${env.T_ID}`, { token: st, form: { occupation: 'E2E' } });
    ok('aluno atualiza o próprio perfil (multipart)', upd.status === 200 && upd.json?.occupation === 'E2E', `${upd.status} ${JSON.stringify(upd.json).slice(0, 160)}`);
    const cert = await req(NEW, 'GET', '/student-certificates', { token: st });
    ok('GET /student-certificates', cert.status === 200 && (cert.json?.rows ?? []).every((x) => x.traineeId === Number(env.T_ID)), `${cert.status}`);
    const prog = await req(NEW, 'GET', '/student-progress/summary', { token: st });
    ok('GET /student-progress/summary', prog.status === 200, `${prog.status}`);
    const asUser = await req(NEW, 'GET', '/customer', { token: st });
    ok('token de aluno não acessa rota de empresa', asUser.status === 401 || asUser.status === 403, `${asUser.status}`);
  }
}

// ─────────────────────────────────────────────── relatório
console.log('\n=== PARIDADE DE LISTAGEM (novo vs antigo, limit=all, super) ===');
for (const p of parity) {
  const flag = p.new !== 200 ? '✖' : (p.sameIds ? '✔' : '≠');
  console.log(`${flag} ${p.route.padEnd(22)} novo=${p.new}/${p.nTotal ?? '-'} antigo=${p.old}/${p.oTotal ?? '-'}` +
    (p.onlyOld.length ? `  só-antigo:[${p.onlyOld.join(',')}]` : '') + (p.onlyNew.length ? `  só-novo:[${p.onlyNew.join(',')}]` : '') +
    (p.err ? `  ERRO: ${JSON.stringify(p.err).slice(0, 160)}` : ''));
}
console.log('\n=== CHECAGENS ===');
for (const r of results) console.log(`${r.pass ? '✔' : '✖'} ${r.name}${r.pass ? '' : '  → ' + r.detail}`);
const fails = results.filter((r) => !r.pass).length + parity.filter((p) => p.new !== 200).length;
console.log(`\n${results.length - results.filter((r) => !r.pass).length}/${results.length} checagens ok · ${parity.filter((p) => p.new === 200).length}/${parity.length} listagens 200 · ${parity.filter((p) => p.sameIds).length} com ids idênticos ao antigo`);
process.exit(fails ? 1 : 0);
