import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Length } from 'class-validator';
import { IsCpf } from 'src/validators/is-cpf.constraint';

export class ValidateStudentDto {
  @IsString()
  @IsCpf({ message: 'CPF informado não é válido' })
  cpf: string;

  @IsString()
  classCode: string;

  @IsInt()
  @Type(() => Number)
  classId: number;
}
