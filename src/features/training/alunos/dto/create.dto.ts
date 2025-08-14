import { Type } from 'class-transformer';
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
  IsJSON,
} from 'class-validator';

export class CreateDto {

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'cpf is required' })
  cpf: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  birthDate?: Date;

  @IsString()
  @IsOptional()
  zipCode?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  addressNumber?: number;

  @IsString()
  @IsOptional()
  complement?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  cityId?: number;

  @IsInt()
  @Type(() => Number)
  stateId?: number;

  @IsInt()
  @Type(() => Number)
  companyId: number;

  @IsString()
  @IsOptional()
  password?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  customerId?: number;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  imageUrl?: string;

  @IsBoolean()
  @Type(() => Boolean)
  @IsNotEmpty({ message: 'active is required' })
  active: boolean;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;

  @IsOptional()
  image?: any;
}
