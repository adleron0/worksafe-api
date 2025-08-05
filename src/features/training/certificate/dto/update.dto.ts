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
  IsJSON,
} from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id?: number;

  @IsString()
  @IsOptional()
  name?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  courseId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  active?: boolean;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  canvasWidth?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  canvasHeight?: number;

  @IsJSON()
  @IsOptional()
  fabricJsonFront?: JSON;

  @IsJSON()
  @IsOptional()
  fabricJsonBack?: JSON;

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
