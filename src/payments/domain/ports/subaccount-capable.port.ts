import { PaymentGatewayPort } from './payment-gateway.port';

/**
 * Port OPCIONAL: nem todo gateway provisiona subcontas para recebedores.
 * O Asaas cria subcontas com walletId; o Stripe usa Connect; o Mercado Pago
 * usa marketplace_fee sobre contas já existentes. Por isso isto é uma
 * capacidade separada, verificada em runtime via `capabilities.subAccounts`.
 */

export interface SellerIdentity {
  id: number;
  name: string;
  cpf: string;
  email: string;
  phone: string;
  birthDate?: any;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  companyId: number;
  sellerConfig?: any;
}

export interface SubAccountResult {
  /** Ambiente em que a subconta foi criada (ex.: sandbox, production). */
  environment: string;
  /** Bloco de configuração a guardar em User.sellerConfig.gateways[gateway]. */
  config: Record<string, any>;
}

export interface SubAccountCapablePort extends PaymentGatewayPort {
  getOrCreateSubAccount(seller: SellerIdentity): Promise<SubAccountResult>;
}

export function supportsSubAccounts(
  adapter: PaymentGatewayPort,
): adapter is SubAccountCapablePort {
  return (
    adapter.capabilities.sellerAccounts &&
    typeof (adapter as SubAccountCapablePort).getOrCreateSubAccount ===
      'function'
  );
}
