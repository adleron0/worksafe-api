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
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'courseId is required' })
  courseId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'active is required' })
  active: boolean;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'canvasWidth is required' })
  canvasWidth: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'canvasHeight is required' })
  canvasHeight: number;

  @IsJSON()
  @IsOptional()
  fabricJsonFront?: JSON;

  @IsJSON()
  @IsOptional()
  fabricJsonBack?: JSON;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
