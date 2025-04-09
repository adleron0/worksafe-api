import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsUrl,
  MinLength,
} from 'class-validator';

export class CreateAreaDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null; // Pode ser null ou omitido

  @IsString()
  @IsOptional()
  @MinLength(10, { message: 'Description must have at least 10 characters' })
  description?: string | null; // Descrição é opcional e pode ser nula

  @IsInt()
  @Type(() => Number) // Garantir conversão para número ao usar class-transformer
  @IsNotEmpty({ message: 'Company ID is required' })
  companyId: number;
}
