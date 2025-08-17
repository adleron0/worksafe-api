import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  Length,
} from 'class-validator';
import { IsCpf } from 'src/validators/is-cpf.constraint';
export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @Length(11, 14) // opcional: obriga entre 11 e 14 caracteres (com ou sem pontuação)
  @IsCpf({ message: 'CPF informado não é válido' })
  cpf: string;

  @IsString()
  @IsNotEmpty({ message: 'email is required' })
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'phone is required' })
  phone: string;

  @IsString()
  @IsOptional()
  workedAt: string;

  @IsString()
  @IsOptional()
  occupation: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  classId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  traineeId?: number;

  @IsString()
  @IsOptional()
  subscribeStatus: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  confirmedAt?: Date;

  @IsString()
  @IsOptional()
  declinedReason?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
