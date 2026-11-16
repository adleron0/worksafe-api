import { StockModule } from 'src/features/stock/module';
import { Module } from '@nestjs/common';
import { EmailModule } from 'src/features/email/email.module';
import { HrModule } from 'src/features/hr/module';
import { FilesModule } from 'src/features/files/module';
import { OperationsModule } from 'src/features/operations/module';
import { ActivityService } from './activity.service';
import { CommercialService } from './commercial.service';
import { ContractService } from './contract.service';
import { DocumentService } from './document.service';
import { PipelineService } from './pipeline.service';
import { ProposalService } from './proposal.service';

@Module({
  imports: [EmailModule, OperationsModule, HrModule, FilesModule, StockModule],
  providers: [ActivityService, CommercialService, ContractService, DocumentService, ProposalService, PipelineService],
  exports: [ActivityService, CommercialService, ContractService, DocumentService, ProposalService, PipelineService],
})
export class CommercialModule {}
