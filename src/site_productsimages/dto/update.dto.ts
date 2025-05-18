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
  @IsString()
  @IsOptional()
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  productId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  active: boolean;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
