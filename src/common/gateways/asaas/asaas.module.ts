import { Module } from '@nestjs/common';
import { AsaasService } from './asaas.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [AsaasService],
  exports: [AsaasService],
})
export class AsaasModule {}
