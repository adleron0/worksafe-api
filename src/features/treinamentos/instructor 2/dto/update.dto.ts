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
  @IsOptional()
  id: number;

  @IsString()
  @IsOptional()
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsString()
  @IsOptional()
  email: string;

  @IsString()
  @IsOptional()
  cpf: string;

  @IsString()
  @IsOptional()
  phone: string;

  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  active: boolean;

  @IsString()
  @IsOptional()
  curriculum: string;

  @IsString()
  @IsOptional()
  highlight: string;

  @IsString()
  @IsOptional()
  formation: string;

  @IsString()
  @IsOptional()
  formationCode: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller

  @IsUrl({}, { message: 'Invalid URL format for signature' })
  @IsOptional()
  signatureUrl?: string | null;

  @IsOptional()
  signature?: any; // Permitir que seja tratado como arquivo no Controller
}
