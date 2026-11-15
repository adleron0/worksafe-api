import { Module } from '@nestjs/common';
import { PrivateStorageService } from './private-storage.service';

/** Armazenamento privado: uma instância só, usada pelo RH e pelos Arquivos da empresa. */
@Module({ providers: [PrivateStorageService], exports: [PrivateStorageService] })
export class PrivateStorageModule {}
