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
  courseId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  traineeId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  classId?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  expirationDate?: Date;

  @IsJSON()
  @IsOptional()
  fabricJsonFront?: JSON;

  @IsJSON()
  @IsOptional()
  fabricJsonBack?: JSON;

  @IsJSON()
  @IsOptional()
  variableToReplace?: JSON;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  pdfUrl?: string;

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
