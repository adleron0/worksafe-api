import { Global, Module } from '@nestjs/common';
import { CompanyEntityController } from './entity.controller';
import { CompanyEntityService } from './entity.service';

/** Empresas do grupo: os CNPJs da WorkSafe num sistema só (worksafe/cnpj-planejamento). Global: todas as áreas usam. */
@Global()
@Module({
  controllers: [CompanyEntityController],
  providers: [CompanyEntityService],
  exports: [CompanyEntityService],
})
export class CompanyEntityModule {}
