import { Module } from '@nestjs/common';
import { StockModule } from 'src/features/stock/module';
import { HrModule } from 'src/features/hr/module';
import { DailyReportService } from './daily-report.service';
import { OrderResultService } from './order-result.service';
import { PurchaseOrderService } from './purchase-order.service';
import { ServiceOrderService } from './service-order.service';

/** Operação: ordens de serviço, RDO, pedidos de compra e resultado da obra. */
@Module({ imports: [HrModule, StockModule], providers: [ServiceOrderService, DailyReportService, PurchaseOrderService, OrderResultService], exports: [ServiceOrderService, DailyReportService, PurchaseOrderService, OrderResultService] })
export class OperationsModule {}
