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
  @IsNotEmpty({ message: 'courseId is required' })
  courseId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'traineeId is required' })
  traineeId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'classId is required' })
  classId: number;

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
  inactiveAt?: Date;
}
