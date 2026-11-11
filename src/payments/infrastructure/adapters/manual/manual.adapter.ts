import { BadRequestException, Injectable } from '@nestjs/common';
import { paymentMethods, gateways } from '@prisma/client';
import { GatewayCapabilities } from 'src/payments/domain/ports/gateway-capabilities';
import {
  CreatePaymentInput,
  CustomerData,
  GatewayPayment,
  PaymentGatewayPort,
  UpdatePaymentInput,
} from 'src/payments/domain/ports/payment-gateway.port';

/**
 * Operação sem provedor de pagamento.
 *
 * Não é um adapter "vazio" nem um stub: é o modo em que a empresa opera hoje
 * quando a turma tem `allowCheckout = false`. O aluno se inscreve, a inscrição
 * fica pendente, o pagamento é combinado por fora (WhatsApp, PIX de conta
 * pessoal, dinheiro, transferência) e alguém dá baixa no painel.
 *
 * Modelar isso como gateway paga dois dividendos: o fluxo manual deixa de ser
 * a ausência de um caminho e passa a ser um caminho com regras próprias; e
 * qualquer relatório financeiro passa a enxergar as três operações — manual,
 * automatizada e hospedada — pela mesma tabela.
 *
 * Nada aqui fala com a rede. Os métodos que dependeriam de um provedor lançam
 * erro explícito em vez de fingir sucesso; o domínio consulta `capabilities`
 * antes de chamá-los, então na prática nunca são atingidos.
 */
@Injectable()
export class ManualAdapter implements PaymentGatewayPort {
  readonly gateway = gateways.manual;

  readonly capabilities: GatewayCapabilities = {
    // Os métodos seguem listados porque a turma continua declarando como
    // pretende receber, e isso vira instrução para o comprador e registro
    // contábil — só não há cobrança automatizada por trás.
    methods: [
      paymentMethods.pix,
      paymentMethods.boleto,
      paymentMethods.cartaoCredito,
    ],
    charge: 'none',
    confirmation: ['manual'],
    approval: 'manual',
    commission: 'manualRecord',
    cardHandling: 'none',
    webhook: 'none',
    webhookAuth: 'none',
    statusQuery: 'none',
    // Parcelar é combinado entre as partes; registramos o que foi acordado.
    maxInstallments: 12,
    sellerAccounts: false,
    updatableCharge: true, // o registro é nosso: dá para corrigir à vontade
    refundable: true, // estornar aqui é mudar o status local
    minorUnits: false,
  };

  private semProvedor(operacao: string): never {
    throw new BadRequestException(
      `Operação "${operacao}" não existe no modo manual: não há provedor para consultar. ` +
        `Ajuste o registro financeiro diretamente.`,
    );
  }

  /** Não há cadastro de cliente em lugar nenhum: o aluno já é nosso. */
  async getOrCreateCustomer(customer: CustomerData) {
    return { id: `manual:${customer.document || 'sem-documento'}` };
  }

  async createPayment(): Promise<GatewayPayment> {
    // O checkout nem deveria chegar aqui: `charge: 'none'` faz o fluxo criar
    // só o registro local. Se chegou, é bug de quem ignorou capabilities.
    return this.semProvedor('criar cobrança');
  }

  async updatePayment(
    _paymentId: string,
    _input: UpdatePaymentInput,
  ): Promise<GatewayPayment> {
    return this.semProvedor('atualizar cobrança');
  }

  async getPaymentDetails(): Promise<GatewayPayment> {
    return this.semProvedor('consultar cobrança');
  }

  async deletePayment() {
    return this.semProvedor('cancelar cobrança');
  }

  /**
   * O status é sempre o que já está gravado: quem manda é o painel, não um
   * provedor. Devolver a entrada de volta mantém o contrato da port sem
   * inventar tradução.
   */
  mapPaymentStatus(status: string): string {
    return status;
  }

  mapPaymentMethod(method: string): paymentMethods {
    return (paymentMethods[method] as paymentMethods) ?? paymentMethods.pix;
  }

  async processWebhook() {
    return this.semProvedor('processar webhook');
  }

  async configureWebhook() {
    // Sem provedor não há webhook a registrar. Devolver vazio em vez de
    // lançar mantém o fluxo de configuração de gateway uniforme.
    return null;
  }

  async primeCredentials(): Promise<void> {
    // Não há credencial: o modo manual não autentica em lugar nenhum.
  }
}
