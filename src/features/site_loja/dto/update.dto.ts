import { Type } from 'class-transformer';
import {
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
} from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsString()
  @IsOptional()
  name: string;

  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  featured: boolean;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional() // Não é obrigatório
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  price: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  oldPrice: number;

  @IsString()
  @IsOptional()
  description: string;

  @IsString()
  @IsOptional()
  @Type(() => String)
  features: string;

  @IsBoolean()
  @IsOptional()
  active: boolean;
}
