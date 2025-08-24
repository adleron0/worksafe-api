import { Module } from '@nestjs/common';
import { GatewayFactory } from './gateway.factory';
import { AsaasModule } from './asaas/asaas.module';

@Module({
  imports: [AsaasModule],
  providers: [GatewayFactory],
  exports: [GatewayFactory],
})
export class GatewayModule {}
