import { Module } from '@nestjs/common';
import { ChartAccountService } from './chart-account.service';
import { FinancialService } from './financial.service';
import { PayableService } from './payable.service';

@Module({ providers: [ChartAccountService, FinancialService, PayableService], exports: [ChartAccountService, FinancialService, PayableService] })
export class FinancialModule {}
