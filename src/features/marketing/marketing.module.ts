import { Module } from '@nestjs/common';
import { MarketingService } from './marketing.service';

@Module({ providers: [MarketingService], exports: [MarketingService] })
export class MarketingModule {}
