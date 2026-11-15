import { Module } from '@nestjs/common';
import { EmployeeService } from './employee.service';

/** RH: cadastro de funcionários, funções e histórico. */
@Module({ providers: [EmployeeService], exports: [EmployeeService] })
export class HrModule {}
