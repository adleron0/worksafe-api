import { Module } from '@nestjs/common';
import { EmployeeDocumentService } from './document.service';
import { EmployeeService } from './employee.service';
import { PrivateStorageModule } from 'src/common/storage/module';

/** RH: cadastro de funcionários, funções, histórico e documentos (armazenamento privado). */
@Module({ imports: [PrivateStorageModule], providers: [EmployeeService, EmployeeDocumentService], exports: [EmployeeService, EmployeeDocumentService] })
export class HrModule {}
