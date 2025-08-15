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
  traineeId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  courseId?: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'classId is required' })
  classId: number;

  @IsJSON()
  @IsOptional()
  courseReview: JSON;

  @IsJSON()
  @IsOptional()
  instructorReview: JSON;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'generalRating is required' })
  generalRating: number;

  @IsString()
  @IsOptional()
  opinionRating?: string;

  @IsBoolean()
  @Type(() => Boolean)
  @IsNotEmpty({ message: 'authorizationExposeReview is required' })
  authorizationExposeReview: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
