import { Module } from '@nestjs/common';
import { EmailModule } from 'src/features/email/email.module';
import { ActivityService } from './activity.service';
import { CommercialService } from './commercial.service';
import { ContractService } from './contract.service';
import { DocumentService } from './document.service';
import { ProposalService } from './proposal.service';

@Module({
  imports: [EmailModule],
  providers: [ActivityService, CommercialService, ContractService, DocumentService, ProposalService],
  exports: [ActivityService, CommercialService, ContractService, DocumentService, ProposalService],
})
export class CommercialModule {}
