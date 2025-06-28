import { Type } from 'class-transformer';
import { IsEmail, IsString, IsNotEmpty, IsInt } from 'class-validator';

export class CreateDto {
  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Customer ID is required' })
  customerId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Role ID is required' })
  roleId: number;

  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'Phone is required' })
  phone: string;
}
