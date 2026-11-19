import { Module } from '@nestjs/common';
import { FinancialrecordsModule } from 'src/features/gateway/financialrecords/module';
import { BalanceService } from './balance.service';
import { ChartAccountService } from './chart-account.service';
import { FinancialService } from './financial.service';
import { LedgerService } from './ledger.service';
import { PayableService } from './payable.service';
import { RecurrenceService } from './recurrence.service';
import { StatementDraftService } from './statement-draft.service';
import { ReportService } from './report.service';
import { TreasuryService } from './treasury.service';
import { RetentionService } from './retention.service';

const services = [BalanceService, ChartAccountService, FinancialService, PayableService, RecurrenceService, LedgerService, ReportService, TreasuryService, StatementDraftService, RetentionService];

@Module({ imports: [FinancialrecordsModule], providers: services, exports: services })
export class FinancialModule {}
