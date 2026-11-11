// Homologação contra o SANDBOX do Asaas, com a API local (porta 3100) sobre a
// cópia local do banco (worksafe_e2e). Não toca produção:
//   - a chave vem de ../../.asaas-sandbox.key (fora do git) e só vale no sandbox;
//   - a API tem de rodar com BASE_SETUP=development e WEBHOOK_URL inválido,
//     para o sandbox nunca entregar eventos à API real.
// Uso: node test/e2e-local/homolog-asaas.mjs   (lê e2e.env do mesmo diretório)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const env = Object.fromEntries(
  readFileSync(join(here, 'e2e.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const KEY = readFileSync(join(here, '../../.asaas-sandbox.key'), 'utf8').trim();
if (!KEY.startsWith('$aact_hmlg_')) throw new Error('A chave não é de sandbox ($aact_hmlg_…). Abortado.');

const API = 'http://localhost:3100';
const SANDBOX = 'https://sandbox.asaas.com/api/v3';
const db = new PrismaClient({ datasources: { db: { url: 'postgresql://adleron@localhost:5432/worksafe_e2e' } } });

const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`); };
const sandbox = (method, path) => fetch(SANDBOX + path, { method, headers: { access_token: KEY, 'User-Agent': 'worksafe-homolog' } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function api(method, path, { token, body, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) { payload = new FormData(); for (const [k, v] of Object.entries(form)) payload.append(k, String(v)); }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + path, { method, headers: h, body: payload });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

const created = { payments: [], webhookId: null };
try {
  const company = await db.company.findFirst({ where: { cnpj: env.CNPJ } });
  const companyId = company.id;
  const login = await api('POST', '/auth/login', { body: { email: env.E_SUPER, password: env.PASS, cnpj: env.CNPJ } });
  const token = login.json?.accessToken;
  ok('login', token);

  // 1. Salvar a integração: gera webhookToken e registra o webhook com authToken.
  const gw = await db.companyGateWays.findFirst({ where: { companyId, gateway: 'asaas' } });
  // Parte do zero na cópia local: sem webhookId/webhookToken herdados.
  await db.companyGateWays.update({ where: { id: gw.id }, data: { payload: { token: 'LOCAL-E2E-FAKE' } } });
  const put = await api('PUT', `/company-gateways/${gw.id}`, { token, form: { payload: JSON.stringify({ token: KEY }) } });
  ok('PUT /company-gateways salva a chave', put.status === 200, `status=${put.status}`);
  const saved = (await db.companyGateWays.findUnique({ where: { id: gw.id } })).payload;
  created.webhookId = saved?.webhookId;
  ok('payload ganhou webhookId', saved?.webhookId, saved?.webhookId);
  ok('payload ganhou webhookToken (48 hex)', /^[0-9a-f]{48}$/.test(saved?.webhookToken ?? ''));
  const wh = await sandbox('GET', `/webhooks/${saved?.webhookId}`);
  ok('webhook existe no sandbox', wh.status === 200, `url=${wh.json?.url} sendType=${wh.json?.sendType}`);
  ok('webhook NÃO aponta para produção', wh.json?.url && !/worksafe/i.test(new URL(wh.json.url).hostname), wh.json?.url);

  // Re-salvar mantém o mesmo token (não troca a cada save).
  await api('PUT', `/company-gateways/${gw.id}`, { token, form: { payload: JSON.stringify({ token: KEY }) } });
  const saved2 = (await db.companyGateWays.findUnique({ where: { id: gw.id } })).payload;
  ok('re-salvar mantém webhookToken e webhookId', saved2.webhookToken === saved.webhookToken && saved2.webhookId === saved.webhookId);

  // 2. Turma de homologação na cópia local.
  const course = await db.course.findFirst({ where: { companyId, inactiveAt: null } });
  const klass = await db.courseClass.create({ data: {
    name: 'HOMOLOG Asaas sandbox', companyId, courseId: course.id, price: 37.9, dividedIn: 1,
    allowCheckout: true, allowSubscriptions: true, unlimitedSubscriptions: true,
    paymentMethods: ['pix', 'boleto'], periodSubscriptionsType: 'UNLIMITED', periodClass: 'UNLIMITED',
  } });

  // 3. Checkout PIX e boleto: cobrança real no sandbox.
  const buyer = { name: 'Homologacao Sandbox', cpf: '52998224725', email: 'homolog@example.com', phone: '81977776666' };
  const subs = {};
  const cpfs = { pix: '52998224725', boleto: '11144477735' };
  for (const method of ['pix', 'boleto']) {
    const email = `homolog+${method}@example.com`;
    const r = await api('POST', '/subscription/subscribe', { form: { ...buyer, cpf: cpfs[method], email, classId: klass.id, paymentMethod: method } });
    ok(`checkout ${method} → 201`, r.status === 201, r.status === 201 ? '' : JSON.stringify(r.json).slice(0, 200));
    const fr = await db.financialRecords.findFirst({ where: { subscription: { classId: klass.id, email } }, orderBy: { id: 'desc' } });
    subs[method] = fr;
    if (fr?.externalId) created.payments.push(fr.externalId);
    const p = await sandbox('GET', `/payments/${fr?.externalId}`);
    ok(`cobrança ${method} existe no sandbox`, p.status === 200, `id=${fr?.externalId} status=${p.json?.status} valor=${p.json?.value} tipo=${p.json?.billingType}`);
    ok(`valor ${method} = preço da turma`, Number(p.json?.value) === 37.9);
  }

  // 4. Webhook: sem header e com token errado → 401; com token → confirma.
  // Usa a cobrança que de fato existe no sandbox (PIX exige conta aprovada).
  const pix = subs.boleto?.externalId ? subs.boleto : subs.pix;
  const payment = (await sandbox('GET', `/payments/${pix.externalId}`)).json;
  const event = { event: 'PAYMENT_RECEIVED', payment: { ...payment, status: 'RECEIVED' } };
  const noHeader = await api('POST', `/webhooks/asaas/${companyId}`, { body: event });
  ok('webhook sem header → 401', noHeader.status === 401, `status=${noHeader.status}`);
  const wrong = await api('POST', `/webhooks/asaas/${companyId}`, { body: event, headers: { 'asaas-access-token': 'errado' } });
  ok('webhook token errado → 401', wrong.status === 401, `status=${wrong.status}`);
  const right = await api('POST', `/webhooks/asaas/${companyId}`, { body: event, headers: { 'asaas-access-token': saved.webhookToken } });
  ok('webhook token certo → 2xx', right.status >= 200 && right.status < 300, `status=${right.status}`);
  const fr = await db.financialRecords.findUnique({ where: { id: pix.id } });
  const sub = await db.courseClassSubscription.findUnique({ where: { id: pix.subscriptionId } });
  ok('registro financeiro recebido', fr.status === 'received', fr.status);
  ok('inscrição confirmada', sub.subscribeStatus === 'confirmed', sub.subscribeStatus);
} catch (e) {
  ok('execução sem exceção', false, e.message);
} finally {
  // Limpeza no sandbox: cobranças e o webhook de homologação.
  // KEEP=1 deixa tudo no sandbox para conferir no painel (apague depois).
  if (process.env.KEEP) {
    console.log(`KEEP: cobranças ${created.payments.join(', ')} · webhook ${created.webhookId}`);
    created.payments = []; created.webhookId = null;
  }
  for (const id of created.payments) await sandbox('DELETE', `/payments/${id}`);
  if (created.webhookId) await sandbox('DELETE', `/webhooks/${created.webhookId}`);
  await db.$disconnect();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} checagens ok · sandbox limpo (${created.payments.length} cobranças, webhook ${created.webhookId ? 'removido' : '—'})`);
  process.exit(pass === results.length ? 0 : 1);
}
