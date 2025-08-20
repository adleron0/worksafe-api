import {
  IsEmail,
  IsString,
  MinLength,
  IsInt,
  IsOptional,
  IsUrl,
  Length,
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
}
