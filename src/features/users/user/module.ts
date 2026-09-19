import { Module } from '@nestjs/common';
import { UserService } from './service';

/** O CRUD do usuário vive no CrudModule; aqui só o findOneUser do login. */
@Module({ providers: [UserService], exports: [UserService] })
export class UserModule {}
