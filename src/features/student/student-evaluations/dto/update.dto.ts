import {
  IsOptional,
  IsNumber,
  IsString,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateDto {
  @IsOptional()
  @IsObject()
  answers?: any;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  score?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  passed?: boolean;

  @IsOptional()
  @IsString()
  feedback?: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  timeSpent?: number;
}
