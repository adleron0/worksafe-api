import { Module } from '@nestjs/common';
import { EmailModule } from 'src/features/email/email.module';
import { CommercialService } from './commercial.service';
import { ContractService } from './contract.service';
import { DocumentService } from './document.service';
import { ProposalService } from './proposal.service';

@Module({
  imports: [EmailModule],
  providers: [CommercialService, ContractService, DocumentService, ProposalService],
  exports: [CommercialService, ContractService, DocumentService, ProposalService],
})
export class CommercialModule {}
