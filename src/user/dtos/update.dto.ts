import {
  IsEmail,
  IsString,
  MinLength,
  Matches,
  IsOptional,
  IsUrl,
} from 'class-validator';

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
  @Matches(/^\d{11}$/, { message: 'CPF must contain exactly 11 digits' })
  @IsOptional()
  cpf: string;

  @IsString()
  @IsOptional()
  companyId: number;

  @IsString()
  @IsOptional()
  profileId: number;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
