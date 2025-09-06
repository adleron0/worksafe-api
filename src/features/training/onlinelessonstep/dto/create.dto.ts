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
  @IsNotEmpty({ message: 'lessonId is required' })
  lessonId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsNotEmpty({ message: 'title is required' })
  title: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'order is required' })
  order: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'duration is required' })
  duration: number;

  @IsString()
  @IsNotEmpty({ message: 'contentType is required' })
  contentType: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'isActive is required' })
  isActive: boolean;

  @IsJSON()
  @IsNotEmpty({ message: 'content is required' })
  content: JSON;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
