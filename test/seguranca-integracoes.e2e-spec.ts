import './setup/env'; // precisa ser o primeiro import

import * as request from 'supertest';
import {
  bootTestApp,
  httpServer,
  shutdownTestApp,
  flushCache,
} from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCheckoutScenario, makeCompany } from './setup/factories';
import {
  mockCheckout,
  resetAsaasMock,
  blockRealNetwork,
} from './setup/asaas-mock';
import {
  describeAsaasError,
  redactAsaasPayload,
} from '../src/common/gateways/asaas/asaas.service';

/**
 * Proteções nas integrações:
 *  - A5: proxy público de imagens (SSRF, redirect, SVG, teto de tamanho)
 *  - A2: dados de cartão e access_token fora dos logs
 *  - C2: webhook do Asaas sem token configurado é recusado
 *
 * Pegadinha: nock 13 não intercepta o `fetch` global (o proxy usa fetch),
 * então o fetch é substituído por um spy; o supertest usa http e não passa
 * por ele.
 */
describe('Segurança das integrações (e2e)', () => {
  const realFetch = global.fetch;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    blockRealNetwork();
    await bootTestApp();
  });

  afterAll(async () => {
    await shutdownTestApp();
    resetAsaasMock();
  });

  beforeEach(async () => {
    await resetDb();
    await flushCache();
    resetAsaasMock();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    global.fetch = realFetch;
    delete process.env.WEBHOOK_REQUIRE_TOKEN;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
  });

  const api = () => request(httpServer());

  // ================= A5: proxy de imagens =================
  describe('[A5] GET /images/proxy', () => {
    const BUCKET_HOST = `${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const proxy = (url: string) => api().get('/images/proxy').query({ url });

    it('aceita imagem do bucket público (virtual-host e path-style)', async () => {
      fetchSpy.mockImplementation(
        async () =>
          new Response(PNG, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      );

      const res = await proxy(`https://${BUCKET_HOST}/images/foto.png`).expect(
        200,
      );
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(res.body, PNG)).toBe(0);
      // nunca segue redirect
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });

      await proxy(
        `https://s3.${process.env.AWS_REGION}.amazonaws.com/${process.env.AWS_S3_BUCKET}/images/foto.png`,
      ).expect(200);
    });

    it('recusa host falso, outro bucket, http, credencial na URL e porta', async () => {
      fetchSpy.mockImplementation(
        async () => new Response(PNG, { status: 200 }),
      );
      const bad = [
        `https://${BUCKET_HOST}.evil.tld/a.png`,
        `https://amazonaws.com.evil.tld/a.png`,
        `https://evil.tld/${BUCKET_HOST}/a.png`,
        `https://outro-bucket.s3.us-east-1.amazonaws.com/a.png`,
        `https://s3.us-east-1.amazonaws.com/outro-bucket/a.png`,
        `https://169.254.169.254/latest/meta-data/`,
        `https://api.railway.internal/a.png`,
        `http://${BUCKET_HOST}/a.png`,
        `https://user:pass@${BUCKET_HOST}/a.png`,
        `https://${BUCKET_HOST}:8443/a.png`,
      ];
      for (const url of bad) {
        const res = await proxy(url);
        expect([url, res.status]).toEqual([url, 403]);
      }
      expect((await proxy('não é url')).status).toBe(400);
      expect((await api().get('/images/proxy')).status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('recusa redirect do bucket (não segue para metadata/rede interna)', async () => {
      fetchSpy.mockImplementation(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
      );
      const res = await proxy(`https://${BUCKET_HOST}/images/foto.png`);
      expect(res.status).toBe(502);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('recusa SVG e tipos que não são imagem', async () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      fetchSpy.mockImplementationOnce(
        async () =>
          new Response(svg, {
            status: 200,
            headers: { 'content-type': 'image/svg+xml' },
          }),
      );
      expect((await proxy(`https://${BUCKET_HOST}/images/a.png`)).status).toBe(
        415,
      );

      // octet-stream com extensão .svg também não passa
      fetchSpy.mockImplementationOnce(
        async () =>
          new Response(svg, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
      );
      expect((await proxy(`https://${BUCKET_HOST}/images/a.svg`)).status).toBe(
        415,
      );

      fetchSpy.mockImplementationOnce(
        async () =>
          new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );
      expect((await proxy(`https://${BUCKET_HOST}/images/a.png`)).status).toBe(
        415,
      );

      // objeto antigo sem content-type, mas com extensão raster: aceito
      fetchSpy.mockImplementationOnce(
        async () =>
          new Response(PNG, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
      );
      const ok = await proxy(`https://${BUCKET_HOST}/images/a.png`).expect(200);
      expect(ok.headers['content-type']).toBe('image/png');
    });

    it('recusa imagem acima do teto (pelo content-length e lendo o corpo)', async () => {
      const BIG = 15 * 1024 * 1024 + 1;
      fetchSpy.mockImplementationOnce(
        async () =>
          new Response(PNG, {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-length': String(BIG),
            },
          }),
      );
      expect((await proxy(`https://${BUCKET_HOST}/images/a.png`)).status).toBe(
        413,
      );

      // sem content-length: aborta ao passar do teto durante a leitura
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > 20) return controller.close();
          sent++;
          controller.enqueue(chunk);
        },
      });
      fetchSpy.mockImplementationOnce(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      );
      expect((await proxy(`https://${BUCKET_HOST}/images/a.png`)).status).toBe(
        413,
      );
      expect(sent).toBeLessThan(20);
    });
  });

  // ================= A2: logs sem dados de cartão =================
  describe('[A2] logs sem cartão nem access_token', () => {
    it('redactAsaasPayload troca cartão e titular por marcador', () => {
      const out = redactAsaasPayload({
        value: 10,
        creditCard: { number: '5162306219378829', ccv: '318' },
        creditCardHolderInfo: { cpfCnpj: '39053344705' },
        creditCardToken: 'tok',
      });
      expect(out).toEqual({
        value: 10,
        creditCard: '[REDACTED]',
        creditCardHolderInfo: '[REDACTED]',
        creditCardToken: '[REDACTED]',
      });
    });

    it('describeAsaasError não inclui headers/config do axios', () => {
      const out = describeAsaasError({
        message: 'Request failed with status code 400',
        code: 'ERR_BAD_REQUEST',
        config: {
          headers: { access_token: '$aact_segredo' },
          data: '{"creditCard":{"number":"5162"}}',
        },
        request: { _header: 'access_token: $aact_segredo' },
        response: {
          status: 400,
          data: {
            errors: [{ code: 'invalid', description: 'Cartão recusado' }],
          },
        },
      });
      expect(out).toEqual({
        status: 400,
        code: 'ERR_BAD_REQUEST',
        message: 'Cartão recusado',
        errors: [{ code: 'invalid', description: 'Cartão recusado' }],
      });
      expect(JSON.stringify(out)).not.toContain('aact');
    });

    it('checkout com cartão não escreve número nem CVV no log', async () => {
      const { courseClass } = await makeCheckoutScenario();
      mockCheckout({
        billingType: 'CREDIT_CARD',
        status: 'CONFIRMED',
        value: 500,
      });
      const logged: string[] = [];
      const capture = (...args: any[]) => {
        logged.push(
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
      };
      const spies = [
        jest.spyOn(console, 'log').mockImplementation(capture),
        jest.spyOn(console, 'error').mockImplementation(capture),
        jest.spyOn(console, 'warn').mockImplementation(capture),
      ];
      try {
        const req = api().post('/subscription/subscribe');
        Object.entries({
          name: 'Maria Souza',
          cpf: '39053344705',
          email: 'maria@teste.local',
          phone: '81999998888',
          address: 'Rua Teste',
          addressNumber: '100',
          neighborhood: 'Centro',
          city: 'Recife',
          state: 'PE',
          zipCode: '50000000',
          classId: String(courseClass.id),
          paymentMethod: 'cartaoCredito',
          creditCard: JSON.stringify({
            cardName: 'MARIA SOUZA',
            cardNumber: '5162306219378829',
            expiryDate: '12/28',
            cvv: '318',
            installments: '1',
          }),
        }).forEach(([k, v]) => req.field(k, v));
        await req.expect(201);

        // parse que falha: nem a string nem a mensagem do JSON.parse vão ao log
        const bad = api().post('/subscription/subscribe');
        Object.entries({
          name: 'Maria Souza',
          cpf: '39053344705',
          email: 'maria@teste.local',
          phone: '81999998888',
          classId: String(courseClass.id),
          paymentMethod: 'pix',
          creditCard: '{"cardNumber":"4111222233334444","cvv":"987"',
        }).forEach(([k, v]) => bad.field(k, v));
        await bad;
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      const all = logged.join('\n');
      expect(all).not.toContain('5162306219378829');
      expect(all).not.toContain('4111222233334444');
      expect(all).not.toMatch(/"ccv"\s*:\s*"318"/);
      expect(all).not.toContain('"987"');
    });
  });

  // ================= C2: webhook do Asaas =================
  describe('[C2] POST /webhooks/asaas/:companyId', () => {
    const TOKEN = 'whtok_teste_0123456789abcdef';

    async function scenario(webhookToken?: string) {
      const s = await makeCheckoutScenario();
      if (webhookToken) {
        await testDb().companyGateWays.updateMany({
          where: { companyId: s.company.id, gateway: 'asaas' },
          data: {
            payload: {
              token: 'tok_teste_asaas',
              webhookId: 'wh_teste',
              webhookToken,
            },
          },
        });
      }
      const sub = await testDb().courseClassSubscription.create({
        data: {
          name: 'Comprador',
          cpf: '11144477735',
          email: 'c@teste.local',
          phone: '81900000000',
          classId: s.courseClass.id,
          companyId: s.company.id,
          subscribeStatus: 'pending',
        },
      });
      return { company: s.company, sub };
    }

    const event = (id: string, subId: number) => ({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id,
        status: 'RECEIVED',
        value: 1,
        billingType: 'PIX',
        dueDate: '2026-12-01',
        externalReference: `sub_${subId}`,
        deleted: false,
      },
    });
    const send = (companyId: number | string, payload: any) =>
      api().post(`/webhooks/asaas/${companyId}`).send(payload);
    const record = (externalId: string) =>
      testDb().financialRecords.findFirst({ where: { externalId } });

    it('sem token configurado (empresa nem global): recusa e não cria registro', async () => {
      const { company, sub } = await scenario();
      const res = await send(company.id, event('pay_sem_token_cfg', sub.id));
      expect(res.status).toBe(401);
      expect(await record('pay_sem_token_cfg')).toBeNull();

      // nem com um header qualquer
      const res2 = await send(
        company.id,
        event('pay_sem_token_cfg2', sub.id),
      ).set('asaas-access-token', 'x');
      expect(res2.status).toBe(401);
    });

    it('empresa sem gateway Asaas ativo: recusa mesmo com token global', async () => {
      process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;
      const company = await makeCompany();
      const res = await send(company.id, {
        event: 'PAYMENT_RECEIVED',
        payment: { id: 'pay_x' },
      }).set('asaas-access-token', TOKEN);
      expect(res.status).toBe(401);
      expect(
        (await send('abc', {}).set('asaas-access-token', TOKEN)).status,
      ).toBe(401);
    });

    it('com token da empresa: recusa token errado e aceita o certo', async () => {
      const { company, sub } = await scenario(TOKEN);
      expect(
        (
          await send(company.id, event('pay_errado', sub.id)).set(
            'asaas-access-token',
            'errado',
          )
        ).status,
      ).toBe(401);
      expect(
        (await send(company.id, event('pay_sem_header', sub.id))).status,
      ).toBe(401);
      expect(await record('pay_errado')).toBeNull();

      await send(company.id, event('pay_certo', sub.id))
        .set('asaas-access-token', TOKEN)
        .expect(201);
      expect((await record('pay_certo'))?.status).toBe('received');
    });

    it('token global (ASAAS_WEBHOOK_TOKEN) vale para empresa com gateway sem token próprio', async () => {
      process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;
      const { company, sub } = await scenario();
      expect(
        (await send(company.id, event('pay_glob_sem', sub.id))).status,
      ).toBe(401);
      await send(company.id, event('pay_glob_ok', sub.id))
        .set('asaas-access-token', TOKEN)
        .expect(201);
    });

    it('WEBHOOK_REQUIRE_TOKEN=false: volta ao modo de transição (aceita sem token configurado)', async () => {
      process.env.WEBHOOK_REQUIRE_TOKEN = 'false';
      const { company, sub } = await scenario();
      await send(company.id, event('pay_transicao', sub.id)).expect(201);
      expect(await record('pay_transicao')).not.toBeNull();
    });
  });
});
