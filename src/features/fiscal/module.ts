import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { EmailModule } from 'src/features/email/email.module';
import { CommercialModule } from 'src/features/commercial/module';
import { InvoiceOriginService } from './invoice.origin';
import { FiscalTrainingJob } from './training.job';
import { FiscalReceivedService } from './received.service';
import { FiscalController } from './fiscal.controller';
import { FiscalInvoiceService } from './invoice.service';
import { FiscalSettingsService } from './settings.service';

/** Área fiscal: NFS-e pelo padrão nacional (worksafe/nfse-planejamento). */
@Module({
  imports: [PrivateStorageModule, EmailModule, CommercialModule],
  controllers: [FiscalController],
  providers: [FiscalSettingsService, FiscalInvoiceService, InvoiceOriginService, FiscalTrainingJob, FiscalReceivedService],
  exports: [FiscalSettingsService, FiscalInvoiceService, FiscalTrainingJob, FiscalReceivedService],
})
export class FiscalModule {}
