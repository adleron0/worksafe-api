import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { gateways } from '@prisma/client';
import { GatewayResolver } from '../infrastructure/gateway-resolver';

/**
 * Configuração da credencial de um gateway para uma empresa.
 *
 * Antes isto vivia em companygateways/rules.ts com um `switch (gateway)`
 * escrito à mão e três variáveis globais mutáveis alimentadas pelo controller
 * (`setAsaasService`, `setCacheService`, `setGatewayFactory`) — um service
 * locator que, além de frágil, obrigava cada gateway novo a ganhar um novo
 * `case` no meio das regras da entidade.
 *
 * Agora quem sabe onde a credencial mora e como registrar o webhook é o
 * adapter. Somar um gateway não toca este arquivo.
 */
@Injectable()
export class GatewayCredentialsService {
  constructor(private readonly gatewayResolver: GatewayResolver) {}

  /** Aceita o payload como objeto ou string JSON, como o front envia. */
  parsePayload(raw: any): any {
    if (!raw) return {};
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Aquece a credencial e registra o webhook, devolvendo o payload com o
   * `webhookId` que o gateway atribuiu.
   *
   * Falha aqui não impede o registro de ser salvo — o comportamento anterior,
   * preservado de propósito: o usuário consegue corrigir a chave e salvar de
   * novo em vez de perder o cadastro inteiro.
   */
  async configure(params: {
    gateway: gateways;
    payload: any;
    companyId: number;
    currentWebhookId?: string;
  }): Promise<any> {
    const { gateway, payload, companyId, currentWebhookId } = params;

    if (!this.gatewayResolver.supports(gateway)) {
      console.log(
        `Gateway ${gateway} não possui configuração de webhook implementada`,
      );
      return payload;
    }

    const adapter = this.gatewayResolver.byName(gateway);
    // Token que autentica o webhook: gerado uma vez e mantido entre saves.
    // Vai ao gateway no registro (authToken) e fica no payload para a API
    // comparar com o header de cada evento recebido.
    const webhookToken: string =
      payload.webhookToken || randomBytes(24).toString('hex');

    try {
      await adapter.primeCredentials(companyId, payload);

      const webhook = await adapter.configureWebhook(
        companyId,
        currentWebhookId || payload.webhookId || null,
        webhookToken,
      );

      // Só grava o token se o gateway aceitou o registro com ele.
      if (webhook?.id) {
        return { ...payload, webhookId: webhook.id, webhookToken };
      }
      return payload;
    } catch (error) {
      console.error(`Erro ao configurar webhook ${gateway}:`, error);
      return payload;
    }
  }
}
