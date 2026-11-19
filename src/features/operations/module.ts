import { Module } from '@nestjs/common';
import { StockModule } from 'src/features/stock/module';
import { HrModule } from 'src/features/hr/module';
import { DailyReportService } from './daily-report.service';
import { OrderResultService } from './order-result.service';
import { PurchaseOrderService } from './purchase-order.service';
import { SaleResultService } from './sale-result.service';
import { ServiceOrderService } from './service-order.service';

/** Operação: ordens de serviço, RDO, pedidos de compra e resultado da obra. */
@Module({ imports: [HrModule, StockModule], providers: [ServiceOrderService, DailyReportService, PurchaseOrderService, OrderResultService, SaleResultService], exports: [ServiceOrderService, DailyReportService, PurchaseOrderService, OrderResultService, SaleResultService] })
export class OperationsModule {}
