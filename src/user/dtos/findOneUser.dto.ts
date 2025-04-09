import { IsString, IsEmail, IsNotEmpty } from 'class-validator';

export class FindUserDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'CNPJ is required' })
  cnpj: string;
}
