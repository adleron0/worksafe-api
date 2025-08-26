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
  @IsNotEmpty({ message: 'day is required' })
  day: number;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'IsPresent is required' })
  IsPresent: boolean;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'traineeId is required' })
  traineeId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'classId is required' })
  classId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
