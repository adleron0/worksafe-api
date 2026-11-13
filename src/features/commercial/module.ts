import { Module } from '@nestjs/common';
import { EmailModule } from 'src/features/email/email.module';
import { CommercialService } from './commercial.service';
import { DocumentService } from './document.service';
import { ProposalService } from './proposal.service';

@Module({
  imports: [EmailModule],
  providers: [CommercialService, DocumentService, ProposalService],
  exports: [CommercialService, DocumentService, ProposalService],
})
export class CommercialModule {}
