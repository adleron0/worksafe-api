import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class StudentLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Email ou CPF é obrigatório' })
  credential: string; // Pode ser email ou CPF

  @IsString()
  @IsNotEmpty({ message: 'Senha é obrigatória' })
  @MinLength(6, { message: 'Senha deve ter no mínimo 6 caracteres' })
  password: string;
}
