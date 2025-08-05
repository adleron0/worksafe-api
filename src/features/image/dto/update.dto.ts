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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  imageUrl?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  width?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  height?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  fileSize?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  createdAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  updatedAt?: Date;

  @IsOptional()
  image?: any;
}
