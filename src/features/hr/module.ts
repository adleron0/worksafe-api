import { Module } from '@nestjs/common';
import { EmployeeDocumentService } from './document.service';
import { EmployeeService } from './employee.service';
import { PrivateStorageService } from './private-storage.service';

/** RH: cadastro de funcionários, funções, histórico e documentos (armazenamento privado). */
@Module({ providers: [EmployeeService, EmployeeDocumentService, PrivateStorageService], exports: [EmployeeService, EmployeeDocumentService] })
export class HrModule {}
