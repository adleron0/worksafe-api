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
  @IsNotEmpty({ message: 'modelId is required' })
  modelId: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'lessonId is required' })
  lessonId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'order is required' })
  order: number;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'isActive is required' })
  isActive: boolean;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
