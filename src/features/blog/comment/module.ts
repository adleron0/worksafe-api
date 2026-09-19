import { Module } from '@nestjs/common';
import { CommentService as Service } from './service';
import { BlogAuthModule } from '../auth/auth.module';

/** CRUD, moderação e rotas públicas vivem no CrudModule; aqui só o service. */
@Module({ imports: [BlogAuthModule], providers: [Service], exports: [Service, BlogAuthModule] })
export class CommentModule {}
