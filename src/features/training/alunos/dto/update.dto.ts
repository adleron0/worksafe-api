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
