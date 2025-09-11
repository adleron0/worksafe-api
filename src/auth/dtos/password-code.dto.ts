import {
  IsString,
  IsNotEmpty,
  IsIn,
  MinLength,
  Matches,
} from 'class-validator';

export class RequestCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'Email ou CPF é obrigatório' })
  credential: string; // Email ou CPF

  @IsString()
  @IsIn(['first_access', 'reset'], {
    message: 'Tipo deve ser "first_access" ou "reset"',
  })
  type: 'first_access' | 'reset';
}

export class VerifyCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'Email ou CPF é obrigatório' })
  credential: string;

  @IsString()
  @IsNotEmpty({ message: 'Código é obrigatório' })
  @Matches(/^\d{6}$/, {
    message: 'Código deve ter 6 dígitos numéricos',
  })
  code: string;
}

export class SetPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Email ou CPF é obrigatório' })
  credential: string;

  @IsString()
  @IsNotEmpty({ message: 'Código é obrigatório' })
  @Matches(/^\d{6}$/, {
    message: 'Código deve ter 6 dígitos numéricos',
  })
  code: string;

  @IsString()
  @IsNotEmpty({ message: 'Nova senha é obrigatória' })
  @MinLength(6, { message: 'Senha deve ter no mínimo 6 caracteres' })
  newPassword: string;
}

export class ResendCodeDto {
  @IsString()
  @IsNotEmpty({ message: 'Email ou CPF é obrigatório' })
  credential: string;
}
