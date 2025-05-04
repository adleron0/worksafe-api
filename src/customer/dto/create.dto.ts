import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsUrl,
  Length,
} from 'class-validator';
import { IsCnpj } from 'src/validators/is-cnpj.constraint';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Corporate name is required' })
  corporateName: string;

  @IsString()
  @Length(14, 18) // 14 dígitos (sem máscara) até 18 (com '.' '/' '-')
  @IsCnpj({ message: 'CNPJ informado não é válido' })
  cnpj: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional() // Não é obrigatório
  imageUrl?: string | null;

  @IsOptional() // Opcional, pois a imagem pode ou não ser enviada
  image?: any; // Permitir que seja tratado como arquivo no Controller

  @IsString()
  @IsOptional() // Não é obrigatório
  description: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Rank ID is required' })
  rankId: number;

  @IsString()
  @IsNotEmpty({ message: 'Phone is required' })
  phone: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'State ID is required' })
  stateId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'City ID is required' })
  cityId: number;

  @IsString()
  @IsOptional() // Não é obrigatório
  neighborhood: string;

  @IsString()
  @IsOptional() // Não é obrigatório
  street: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional() // Não é obrigatório
  number: number;

  @IsString()
  @IsOptional() // Não é obrigatório
  complement: string;

  @IsString()
  @IsOptional() // Não é obrigatório
  zipcode: string;
}
