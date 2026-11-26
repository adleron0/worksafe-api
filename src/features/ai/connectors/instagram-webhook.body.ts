import { INestApplication } from '@nestjs/common';
import * as express from 'express';

export const INSTAGRAM_WEBHOOK_PATH = '/ai/connectors/instagram/webhook';

/**
 * O webhook da Meta assina o corpo BRUTO (X-Hub-Signature-256). Este parser
 * entra antes do express.json (main.ts) e do parser do Nest só nesta rota:
 * req.body chega como Buffer e os outros parsers pulam (req._body já marcado).
 * As demais rotas não mudam.
 */
export function mountInstagramWebhookBody(app: INestApplication): void {
  app.use(INSTAGRAM_WEBHOOK_PATH, express.raw({ type: () => true, limit: '2mb' }));
  // WhatsApp oficial (Conversas): mesma assinatura da Meta, por número
  app.use('/chat/webhook/cloud', express.raw({ type: () => true, limit: '5mb' }));
}
