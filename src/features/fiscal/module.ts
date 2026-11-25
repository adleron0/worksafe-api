import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { EmailModule } from 'src/features/email/email.module';
import { FiscalController } from './fiscal.controller';
import { FiscalInvoiceService } from './invoice.service';
import { FiscalSettingsService } from './settings.service';

/** Área fiscal: NFS-e pelo padrão nacional (worksafe/nfse-planejamento). */
@Module({
  imports: [PrivateStorageModule, EmailModule],
  controllers: [FiscalController],
  providers: [FiscalSettingsService, FiscalInvoiceService],
  exports: [FiscalSettingsService, FiscalInvoiceService],
})
export class FiscalModule {}
