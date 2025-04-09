import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsInt,
  MinLength,
  Matches,
  IsOptional,
  IsUrl,
} from 'class-validator';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Senha deve ter pelo menos 6 caracteres' })
  @IsNotEmpty({ message: 'Password is required' })
  password: string;

  @IsString()
  @IsNotEmpty({ message: 'Phone number is required' })
  phone: string;

  @IsString()
  @Matches(/^\d{11}$/, { message: 'CPF must contain exactly 11 digits' }) // Exige 11 dígitos numéricos
  cpf: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Company ID is required' })
  companyId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Role ID is required' })
  roleId: number;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional() // Não é obrigatório
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
