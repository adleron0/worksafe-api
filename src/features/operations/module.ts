import { Module } from '@nestjs/common';
import { DailyReportService } from './daily-report.service';
import { ServiceOrderService } from './service-order.service';

/** Operação: ordens de serviço e RDO. */
@Module({ providers: [ServiceOrderService, DailyReportService], exports: [ServiceOrderService, DailyReportService] })
export class OperationsModule {}
