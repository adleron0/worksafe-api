import {
  IsEmail,
  IsString,
  MinLength,
  IsInt,
  IsOptional,
  IsUrl,
  Length,
  IsJSON,
  IsBoolean,
  IsDateString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { IsCpf } from 'src/validators/is-cpf.constraint';

export class UpdateDto {
  @IsString()
  @IsOptional()
  name: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @IsOptional()
  email: string;

  @IsString()
  @IsOptional()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password: string;

  @IsString()
  @IsOptional()
  phone: string;

  @IsString()
  @Length(11, 14) // opcional: obriga entre 11 e 14 caracteres (com ou sem pontuação)
  @IsCpf({ message: 'CPF informado não é válido' })
  @IsOptional()
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
  @IsOptional()
  @Type(() => Number)
  companyId: number;

  @IsInt()
  @IsOptional()
  @Type(() => Number)
  profileId: number;

  @IsOptional()
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
