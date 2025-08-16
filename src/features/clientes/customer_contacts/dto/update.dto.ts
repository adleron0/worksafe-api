import { Type, Transform } from 'class-transformer';
import { IsEmail, IsString, IsInt, IsOptional } from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  customerId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  roleId: number;

  @IsString()
  @IsOptional()
  name: string;

  @IsEmail()
  @IsOptional()
  email: string;

  @IsString()
  @IsOptional()
  phone: string;
}
