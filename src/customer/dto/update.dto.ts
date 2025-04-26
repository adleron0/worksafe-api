import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id: number;

  @IsString()
  @IsOptional()
  name: string;

  @IsString()
  @IsOptional()
  corporateName: string;

  @IsBoolean()
  @IsOptional()
  active: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsString()
  @IsOptional()
  cnpj: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller

  @IsString()
  @IsOptional()
  description: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  rankId: number;

  @IsString()
  @IsOptional()
  phone: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @IsOptional()
  email: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  stateId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  cityId: number;

  @IsString()
  @IsOptional()
  neighborhood: string;

  @IsString()
  @IsOptional()
  street: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  number: number;

  @IsString()
  @IsOptional()
  complement: string;

  @IsString()
  @IsOptional()
  zipcode: string;
}
