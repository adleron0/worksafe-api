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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  postId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  parentId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  depth?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  visitorId?: number;

  @IsString()
  @IsOptional()
  content?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  rating?: number;

  @IsString()
  @IsOptional()
  status?: string;

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
