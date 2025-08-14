import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class UpdateDto {

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id?: number;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  cpf?: string;

  @IsString()
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email format' })
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  workedAt?: string;

  @IsString()
  @IsOptional()
  occupation?: string;

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
  subscribeStatus?: string;

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
  createdAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  updatedAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
