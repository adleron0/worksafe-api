import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { CompanyFileService } from './file.service';

/** Arquivos da empresa: pastas em árvore, arquivos no armazenamento privado e lixeira. */
@Module({ imports: [PrivateStorageModule], providers: [CompanyFileService], exports: [CompanyFileService] })
export class FilesModule {}
