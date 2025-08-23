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
  Length,
  IsEnum,
  IsObject,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { IsCpf } from 'src/validators/is-cpf.constraint';
import { paymentMethods } from '@prisma/client';
export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @Length(11, 14) // opcional: obriga entre 11 e 14 caracteres (com ou sem pontuação)
  @IsCpf({ message: 'CPF informado não é válido' })
  cpf: string;

  @IsString()
  @IsNotEmpty({ message: 'email is required' })
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'phone is required' })
  phone: string;

  @IsString()
  @IsOptional()
  workedAt: string;

  @IsString()
  @IsOptional()
  occupation: string;

  // Campos de endereço (importantes para checkout)
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
  @Transform(({ value }) => value?.replace(/[^\d]/g, ''))
  zipCode?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  classId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  traineeId?: number;

  @IsString()
  @IsOptional()
  subscribeStatus: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  confirmedAt?: Date;

  @IsString()
  @IsOptional()
  declinedReason?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;

  // Campos de pagamento (quando allowCheckout = true)
  @ValidateIf((o) => o.paymentMethod !== undefined)
  @IsEnum(paymentMethods, { message: 'Método de pagamento inválido' })
  @IsOptional()
  paymentMethod?: paymentMethods;

  @ValidateIf((o) => o.paymentMethod === paymentMethods.cartaoCredito)
  @IsObject()
  @ValidateNested()
  @Type(() => CreditCardDto)
  @IsOptional()
  creditCard?: any;

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerDto)
  @IsOptional()
  customerData?: any;
}

// DTOs para checkout integrado
class CreditCardDto {
  @IsString()
  @IsNotEmpty({ message: 'Nome do titular é obrigatório' })
  cardName: string;

  @IsString()
  @IsNotEmpty({ message: 'Número do cartão é obrigatório' })
  @Transform(({ value }) => value?.replace(/\s/g, ''))
  cardNumber: string;

  @IsString()
  @IsNotEmpty({ message: 'Data de validade é obrigatória' })
  expiryDate: string;

  @IsString()
  @IsNotEmpty({ message: 'CVV é obrigatório' })
  cvv: string;

  @IsString()
  @IsOptional()
  token?: string;
}

class CustomerDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.replace(/[^\d]/g, ''))
  document?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  number?: string;

  @IsString()
  @IsOptional()
  complement?: string;

  @IsString()
  @IsOptional()
  neighborhood?: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.replace(/[^\d]/g, ''))
  zipCode?: string;
}
