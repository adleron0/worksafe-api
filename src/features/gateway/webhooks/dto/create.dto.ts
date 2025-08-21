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
  IsJSON,
} from 'class-validator';

export class CreateDto {

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsNotEmpty({ message: 'gateway is required' })
  gateway: string;

  @IsJSON()
  @IsOptional()
  payload?: JSON;

  @IsJSON()
  @IsOptional()
  error?: JSON;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  processedAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
