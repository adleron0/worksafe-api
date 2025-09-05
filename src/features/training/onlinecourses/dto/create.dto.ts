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
  @IsNotEmpty({ message: 'courseId is required' })
  courseId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsOptional()
  key: string;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'isActive is required' })
  isActive: boolean;
}
