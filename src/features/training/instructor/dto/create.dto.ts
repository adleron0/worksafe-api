import { Type, Transform } from 'class-transformer';
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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsString()
  @IsNotEmpty({ message: 'email is required' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'cpf is required' })
  cpf: string;

  @IsString()
  @IsOptional()
  phone: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  active: boolean;

  @IsString()
  @IsNotEmpty({ message: 'curriculum is required' })
  curriculum: string;

  @IsString()
  @IsOptional()
  highlight: string;

  @IsString()
  @IsNotEmpty({ message: 'formation is required' })
  formation: string;

  @IsString()
  @IsOptional()
  formationCode: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
