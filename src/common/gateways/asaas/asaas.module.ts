import { Module } from '@nestjs/common';
import { AsaasService } from './asaas.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from 'src/common/cache/cache.module';

@Module({
  imports: [PrismaModule, ConfigModule, CacheModule],
  providers: [AsaasService],
  exports: [AsaasService],
})
export class AsaasModule {}
