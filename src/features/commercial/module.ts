import { Module } from '@nestjs/common';
import { CommercialService } from './commercial.service';

@Module({ providers: [CommercialService], exports: [CommercialService] })
export class CommercialModule {}
