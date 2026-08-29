import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { AsaasAdapter } from './infrastructure/adapters/asaas/asaas.adapter';
import { GatewayResolver } from './infrastructure/gateway-resolver';

/**
 * Módulo do domínio financeiro.
 *
 * Só o GatewayResolver é exportado: quem precisa cobrar passa por ele e recebe
 * uma PaymentGatewayPort. Nenhum consumidor fora daqui deve importar um
 * adapter concreto.
 *
 * O AsaasModule ainda é importado porque o adapter delega ao AsaasService
 * nesta fase. Quando a lógica migrar para dentro do adapter (fase 2), essa
 * dependência sai.
 */
@Module({
  imports: [PrismaModule, AsaasModule],
  providers: [AsaasAdapter, GatewayResolver],
  exports: [GatewayResolver],
})
export class PaymentsModule {}
