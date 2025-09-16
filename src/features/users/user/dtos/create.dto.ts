import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsInt,
  MinLength,
  IsBoolean,
  IsOptional,
  IsUrl,
  Length,
  IsJSON,
  IsDateString,
} from 'class-validator';
import { IsCpf } from 'src/validators/is-cpf.constraint';

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
  @Length(11, 14) // opcional: obriga entre 11 e 14 caracteres (com ou sem pontuação)
  @IsCpf({ message: 'CPF informado não é válido' })
  cpf: string;

  @IsDateString()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    // Se já for uma data ISO-8601 completa, retorna como está
    if (value.includes('T')) return value;
    // Se for apenas data (YYYY-MM-DD), adiciona tempo padrão
    return `${value}T00:00:00.000Z`;
  })
  birthDate?: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Role ID is required' })
  profileId: number;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional() // Não é obrigatório
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  isSeller?: boolean;

  @IsString()
  @IsOptional()
  sellerStatus?: string;

  @IsJSON()
  @IsOptional()
  sellerConfig?: any;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  addressNumber?: string;

  @IsString()
  @IsOptional()
  addressComplement?: string;

  @IsString()
  @IsOptional()
  neighborhood?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  zipCode?: string;
}
