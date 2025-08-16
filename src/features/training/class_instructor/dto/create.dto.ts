import { Type, Transform } from 'class-transformer';
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
  @IsNotEmpty({ message: 'classId is required' })
  classId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'instructorId is required' })
  instructorId: number;
}
