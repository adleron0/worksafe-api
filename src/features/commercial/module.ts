import { Module } from '@nestjs/common';
import { CommercialService } from './commercial.service';
import { ProposalService } from './proposal.service';

@Module({ providers: [CommercialService, ProposalService], exports: [CommercialService, ProposalService] })
export class CommercialModule {}
