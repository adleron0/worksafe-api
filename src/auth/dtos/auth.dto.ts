import { IsEmail, IsString, IsNotEmpty, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Fromato de email inválido' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'A Senha deve conter no mínimo 8 caracteres' })
  @IsNotEmpty({ message: 'Password is required' })
  password: string;

  @IsString()
  @Matches(/^\d{14}$/, { message: 'CNPJ deve conter 14 dígitos' })
  @IsNotEmpty({ message: 'CNPJ is required' })
  cnpj: string;
}
