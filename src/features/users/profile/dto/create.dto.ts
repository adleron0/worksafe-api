import { Type } from 'class-transformer';
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
} from 'class-validator';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;
}
