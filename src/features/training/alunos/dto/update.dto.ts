import { Type, Transform } from 'class-transformer';
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
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  active?: boolean;

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

  @IsOptional()
  image?: any;
}
