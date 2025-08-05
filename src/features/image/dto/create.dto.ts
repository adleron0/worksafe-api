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
  IsJSON,
} from 'class-validator';

export class CreateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @IsOptional()
  imageUrl: string;

  @IsString()
  @IsNotEmpty({ message: 'type is required' })
  type: string;

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

  @IsOptional()
  image?: any;
}
