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
  @IsNotEmpty({ message: 'traineeId is required' })
  traineeId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'courseId is required' })
  courseId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'classId is required' })
  classId: number;

  @IsJSON()
  @IsNotEmpty({ message: 'examResponses is required' })
  examResponses: JSON;

  @IsBoolean()
  @Type(() => Boolean)
  @IsNotEmpty({ message: 'result is required' })
  result: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;
}
