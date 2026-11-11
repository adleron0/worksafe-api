import { GatewayCredentialsService } from 'src/payments/application/gateway-credentials.service';

function setup(webhookResult: any = { id: 'wh_1' }) {
  const adapter = {
    primeCredentials: jest.fn().mockResolvedValue(undefined),
    configureWebhook: jest.fn().mockResolvedValue(webhookResult),
  };
  const resolver = { supports: () => true, byName: () => adapter } as any;
  return { adapter, service: new GatewayCredentialsService(resolver) };
}

describe('GatewayCredentialsService.configure — token do webhook', () => {
  it('gera webhookToken, registra no gateway e devolve no payload', async () => {
    const { adapter, service } = setup();
    const out = await service.configure({ gateway: 'asaas' as any, payload: { token: 'k' }, companyId: 1 });
    expect(out.webhookToken).toMatch(/^[0-9a-f]{48}$/);
    expect(out.webhookId).toBe('wh_1');
    expect(adapter.configureWebhook).toHaveBeenCalledWith(1, null, out.webhookToken);
  });

  it('preserva o token existente entre saves', async () => {
    const { adapter, service } = setup();
    const out = await service.configure({
      gateway: 'asaas' as any, payload: { token: 'k', webhookToken: 'existente' }, companyId: 1, currentWebhookId: 'wh_1',
    });
    expect(out.webhookToken).toBe('existente');
    expect(adapter.configureWebhook).toHaveBeenCalledWith(1, 'wh_1', 'existente');
  });

  it('não grava token se o gateway não confirmou o registro', async () => {
    const { service } = setup(null);
    const out = await service.configure({ gateway: 'asaas' as any, payload: { token: 'k' }, companyId: 1 });
    expect(out.webhookToken).toBeUndefined();
  });
});
