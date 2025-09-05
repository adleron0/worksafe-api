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
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  courseId?: number;

  @IsString()
  @IsNotEmpty({ message: 'title is required' })
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  version?: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'isActive is required' })
  isActive: boolean;

  @IsJSON()
  @IsNotEmpty({ message: 'progressConfig is required' })
  progressConfig: JSON;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
