import { Module } from '@nestjs/common';
import { DailyReportService } from './daily-report.service';
import { PurchaseOrderService } from './purchase-order.service';
import { ServiceOrderService } from './service-order.service';

/** Operação: ordens de serviço, RDO e pedidos de compra. */
@Module({ providers: [ServiceOrderService, DailyReportService, PurchaseOrderService], exports: [ServiceOrderService, DailyReportService, PurchaseOrderService] })
export class OperationsModule {}
