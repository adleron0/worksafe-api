import { Module } from '@nestjs/common';
import { ServiceOrderService } from './service-order.service';

/** Operação: ordens de serviço. */
@Module({ providers: [ServiceOrderService], exports: [ServiceOrderService] })
export class OperationsModule {}
