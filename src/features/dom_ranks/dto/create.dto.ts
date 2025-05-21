import { IsString, IsNotEmpty, IsOptional, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsString()
  @IsOptional()
  color: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Company ID is required' })
  companyId: number;
}
