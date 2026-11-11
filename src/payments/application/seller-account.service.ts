import { BadRequestException, Injectable } from '@nestjs/common';
import { GatewayResolver } from '../infrastructure/gateway-resolver';
import {
  SellerIdentity,
  supportsSubAccounts,
} from '../domain/ports/subaccount-capable.port';

/**
 * Provisionamento da subconta de um vendedor no gateway.
 *
 * Antes isto vivia dentro de users/user/rules.ts, que instanciava
 * `new AsaasService(prisma, new ConfigService(), new CacheService())` à mão —
 * fora do container do Nest e abrindo uma conexão Redis nova a cada chamada.
 *
 * Aqui o service é injetado normalmente e fala com a port. O hook de CRUD
 * passa a delegar para cá em vez de conhecer fornecedor.
 */
@Injectable()
export class SellerAccountService {
  constructor(private readonly gatewayResolver: GatewayResolver) {}

  /** Campos sem os quais o gateway recusa a abertura da subconta. */
  private validate(seller: Partial<SellerIdentity>): void {
    const missing: string[] = [];
    if (!seller.email) missing.push('Email é obrigatório');
    if (!seller.cpf) missing.push('CPF é obrigatório');
    if (!seller.phone) missing.push('Telefone é obrigatório');
    if (!seller.name) missing.push('Nome é obrigatório');

    if (missing.length > 0) {
      throw new BadRequestException(
        `Dados insuficientes para criar vendedor: ${missing.join(', ')}`,
      );
    }

    if (
      !seller.zipCode ||
      !seller.address ||
      !seller.neighborhood ||
      !seller.city ||
      !seller.state
    ) {
      console.warn(
        'Endereço incompleto - subconta será criada com dados mínimos',
      );
    }
  }

  /**
   * Garante a subconta e devolve o `sellerConfig` já mesclado, preservando os
   * ambientes e gateways que já existiam. A mesclagem por ambiente importa:
   * uma conta de sandbox não pode sobrescrever a de produção.
   */
  async provision(
    seller: SellerIdentity,
    currentConfig?: any,
  ): Promise<{ sellerConfig: any; environment: string }> {
    this.validate(seller);

    const { adapter } = await this.gatewayResolver.forCompany(seller.companyId);

    if (!supportsSubAccounts(adapter)) {
      throw new BadRequestException(
        `O gateway ${adapter.gateway} não suporta subcontas de vendedor`,
      );
    }

    const result = await adapter.getOrCreateSubAccount(seller);
    const gatewayKey = adapter.gateway;

    return {
      environment: result.environment,
      sellerConfig: {
        ...currentConfig,
        ...seller.sellerConfig,
        gateways: {
          ...currentConfig?.gateways,
          ...seller.sellerConfig?.gateways,
          [gatewayKey]: {
            ...currentConfig?.gateways?.[gatewayKey],
            ...seller.sellerConfig?.gateways?.[gatewayKey],
            [result.environment]: result.config,
          },
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Já existe subconta para o ambiente corrente deste gateway?
   * Evita chamar o gateway de novo a cada update do usuário.
   */
  async hasAccountForCurrentEnvironment(
    companyId: number,
    sellerConfig: any,
  ): Promise<boolean> {
    if (!sellerConfig) return false;
    const { adapter } = await this.gatewayResolver.forCompany(companyId);
    const environment =
      process.env.BASE_SETUP === 'development' ? 'sandbox' : 'production';
    return Boolean(
      sellerConfig?.gateways?.[adapter.gateway]?.[environment]?.walletId,
    );
  }
}
