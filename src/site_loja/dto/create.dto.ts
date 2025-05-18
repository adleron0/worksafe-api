import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
} from 'class-validator';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsBoolean()
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
  @Type(() => Boolean)
  features: string;

  @IsBoolean()
  @IsOptional()
  active: boolean;
}
