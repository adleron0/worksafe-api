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

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'active is required' })
  active: boolean;

  @IsString()
  @IsNotEmpty({ message: 'cnpj is required' })
  cnpj: string;

  @IsString()
  @IsNotEmpty({ message: 'comercial_name is required' })
  comercial_name: string;

  @IsString()
  @IsNotEmpty({ message: 'corporate_name is required' })
  corporate_name: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  logoUrl?: string;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  logo?: any; // Permitir que seja tratado como arquivo no Controller

  @IsString()
  @IsOptional()
  primary_color?: string;

  @IsString()
  @IsOptional()
  secondary_color?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  stateId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  cityId?: number;

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
  zipCode?: string;

  @IsString()
  @IsOptional()
  segment?: string;

  @IsString()
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email format' })
  representative_email?: string;

  @IsString()
  @IsOptional()
  representative_contact?: string;

  @IsString()
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email format' })
  financial_email?: string;

  @IsString()
  @IsOptional()
  financial_contact?: string;

  @IsString()
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email format' })
  operational_email?: string;

  @IsString()
  @IsOptional()
  operational_contact?: string;

  @IsJSON()
  @IsOptional()
  @IsEmail({}, { message: 'Invalid email format' })
  email_conection?: JSON;

  @IsString()
  @IsOptional()
  lp_domain?: string;

  @IsString()
  @IsOptional()
  system_domain?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  websiteUrl?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  facebookUrl?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  instagramUrl?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  linkedinUrl?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
