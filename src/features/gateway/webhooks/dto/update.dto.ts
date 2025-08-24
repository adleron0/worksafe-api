import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsOptional()
  gateway?: string;

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
  createdAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  updatedAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
