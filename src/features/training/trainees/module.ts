import { Module } from '@nestjs/common';
import { AlunosController as Controller } from './controller';
import { AlunosService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
  exports: [Service], // Exporta o service para outros módulos poderem usar
})
export class AlunosModule {}
