import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { FinancialrecordsService as Service } from './service';

@Module({ providers: [Service], imports: [UploadModule], exports: [Service] })
export class FinancialrecordsModule {}
