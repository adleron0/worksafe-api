import { Module } from '@nestjs/common';
import { CompanyService as Service } from './service';

/** CRUD e first-steps vivem no CrudModule; aqui só o service. */
@Module({ providers: [Service], exports: [Service] })
export class CompanyModule {}
