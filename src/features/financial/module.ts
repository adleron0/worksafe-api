import { Module } from '@nestjs/common';
import { ChartAccountService } from './chart-account.service';
import { FinancialService } from './financial.service';

@Module({ providers: [ChartAccountService, FinancialService], exports: [ChartAccountService, FinancialService] })
export class FinancialModule {}
