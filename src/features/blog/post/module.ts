import { Module } from '@nestjs/common';
import { PostService as Service } from './service';

/** O CRUD e as rotas custom do post vivem no CrudModule; aqui só o service (slug público). */
@Module({ providers: [Service], exports: [Service] })
export class PostModule {}
