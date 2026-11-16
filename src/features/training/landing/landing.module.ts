import { Module } from '@nestjs/common';
import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

@Module({ controllers: [LandingController], providers: [LandingService], exports: [LandingService] })
export class LandingModule {}
