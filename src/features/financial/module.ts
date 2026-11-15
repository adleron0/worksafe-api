import { Module } from '@nestjs/common';
import { FinancialrecordsModule } from 'src/features/gateway/financialrecords/module';
import { ChartAccountService } from './chart-account.service';
import { FinancialService } from './financial.service';
import { LedgerService } from './ledger.service';
import { PayableService } from './payable.service';
import { RecurrenceService } from './recurrence.service';
import { ReportService } from './report.service';
import { TreasuryService } from './treasury.service';

const services = [ChartAccountService, FinancialService, PayableService, RecurrenceService, LedgerService, ReportService, TreasuryService];

@Module({ imports: [FinancialrecordsModule], providers: services, exports: services })
export class FinancialModule {}
