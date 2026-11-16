import { Module } from '@nestjs/common';
import { CommercialModule } from 'src/features/commercial/module';
import { FinancialModule } from 'src/features/financial/module';
import { HrModule } from 'src/features/hr/module';
import { OperationsModule } from 'src/features/operations/module';
import { CommercialSection } from './commercial.section';
import { DashboardService } from './dashboard.service';
import { FinanceSection } from './finance.section';
import { OperationsSection } from './operations.section';
import { PeopleSection } from './people.section';
import { WeekSection } from './week.section';

@Module({
  imports: [FinancialModule, CommercialModule, OperationsModule, HrModule],
  providers: [DashboardService, FinanceSection, CommercialSection, OperationsSection, PeopleSection, WeekSection],
  exports: [DashboardService],
})
export class DashboardModule {}
