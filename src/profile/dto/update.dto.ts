import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
} from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsString()
  @IsOptional()
  name: string;
}
