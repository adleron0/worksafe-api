import { paymentMethods } from '@prisma/client';

/**
 * O que um provedor de pagamento sabe fazer.
 *
 * Este arquivo é o coração do desacoplamento. A regra é: o domínio pergunta
 * "você sabe fazer X?" e nunca "você é o Asaas?". Cada eixo abaixo existe
 * porque o comportamento do sistema REALMENTE muda em função dele — nenhum é
 * decorativo.
 *
 * Três provedores exercitam a escala inteira:
 *  - manual       — sem gateway: cobrança combinada fora do sistema
 *  - asaas        — automação completa
 *  - infinitePay  — checkout do provedor, comissão administrada por nós
 */

/** Como a cobrança nasce e como ela chega ao comprador. */
export type ChargeModel =
  /** Não existe cobrança no provedor. O registro é local e o pagamento é
   *  combinado fora do sistema (WhatsApp, PIX de conta pessoal, dinheiro). */
  | 'none'
  /** O provedor devolve os DADOS da cobrança (QR do PIX, copia-e-cola, linha
   *  digitável) e o checkout é renderizado por nós. */
  | 'apiData'
  /** O provedor devolve um LINK e o comprador é redirecionado para o
   *  checkout dele. Não vemos os dados da cobrança. */
  | 'hostedLink';

/** Quem declara que o dinheiro entrou. */
export type ConfirmationModel =
  /** Alguém marca como pago no painel. */
  | 'manual'
  /** O provedor avisa por webhook. */
  | 'webhook';

/** Como o provedor avisa sobre mudanças de status. */
export type WebhookModel =
  | 'none'
  /** Registrado uma vez por empresa, via API do provedor. */
  | 'registered'
  /** Informado a cada cobrança, no próprio payload de criação. */
  | 'perCharge';

/** O que autentica um webhook recebido. */
export type WebhookAuth =
  /** Nada: a origem não é verificável. Exige confirmação ativa via consulta. */
  | 'none'
  /** Token compartilhado em header. */
  | 'token'
  /** Assinatura criptográfica do corpo. */
  | 'hmac';

/** Como consultamos o estado real de uma cobrança. */
export type StatusQueryModel =
  | 'none'
  /** Consulta pelo id da cobrança no provedor. */
  | 'byChargeId'
  /** Endpoint dedicado de verificação (ex.: payment_check). */
  | 'byVerification';

/** Como a comissão do vendedor chega até ele. */
export type CommissionModel =
  /** Só registramos o quanto é devido; o repasse é feito por fora. */
  | 'manualRecord'
  /** O provedor divide o valor na própria transação. */
  | 'gatewaySplit';

/** Quando a inscrição passa de pendente a confirmada. */
export type ApprovalModel =
  /** Alguém aprova no painel, independente de pagamento. */
  | 'manual'
  /** Confirma sozinha quando o pagamento é confirmado. */
  | 'onPayment';

/** Quem toca nos dados do cartão — define o escopo de PCI. */
export type CardHandling =
  /** Nunca vemos o cartão. */
  | 'none'
  /** O PAN passa pela nossa API. Coloca o backend em escopo PCI SAQ-D. */
  | 'serverSide'
  /** O cliente tokeniza no browser; recebemos só o token. */
  | 'clientToken';

export interface GatewayCapabilities {
  /** Métodos que o provedor aceita. Vazio significa "não cobra". */
  methods: paymentMethods[];

  charge: ChargeModel;
  confirmation: ConfirmationModel[];
  approval: ApprovalModel;
  commission: CommissionModel;
  cardHandling: CardHandling;

  webhook: WebhookModel;
  webhookAuth: WebhookAuth;
  statusQuery: StatusQueryModel;

  /** 1 = à vista apenas. */
  maxInstallments: number;

  /** Provisiona subconta para o vendedor receber direto. */
  sellerAccounts: boolean;
  /** Permite alterar uma cobrança já criada (valor, método, vencimento). */
  updatableCharge: boolean;
  /** Permite cancelar/estornar pela API. */
  refundable: boolean;
  /** Valores trafegam em centavos em vez de reais. */
  minorUnits: boolean;
}

/**
 * Perguntas de conveniência. Existem para que o código de domínio leia como
 * intenção ("este provedor cobra?") em vez de comparação de string solta.
 */
export const capabilityChecks = {
  /** Há cobrança automatizada, de qualquer forma? */
  charges: (c: GatewayCapabilities) => c.charge !== 'none',

  /** O comprador precisa sair do nosso site para pagar? */
  redirects: (c: GatewayCapabilities) => c.charge === 'hostedLink',

  /** Renderizamos QR/boleto na nossa própria página? */
  rendersChargeData: (c: GatewayCapabilities) => c.charge === 'apiData',

  /** A comissão precisa ser paga a mão depois? */
  needsManualPayout: (c: GatewayCapabilities) =>
    c.commission === 'manualRecord',

  /** Dá para confiar no webhook sozinho, sem consultar o provedor? */
  webhookIsTrustworthy: (c: GatewayCapabilities) => c.webhookAuth !== 'none',

  /** Alguém precisa marcar como pago no painel? */
  needsManualConfirmation: (c: GatewayCapabilities) =>
    c.confirmation.includes('manual'),

  /** O PAN passa pela nossa infraestrutura? */
  inPciScope: (c: GatewayCapabilities) => c.cardHandling === 'serverSide',
};
