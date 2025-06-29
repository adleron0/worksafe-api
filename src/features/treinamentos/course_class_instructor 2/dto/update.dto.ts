import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class UpdateDto {
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  classId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  instructorId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsBoolean()
  @IsOptional()
  active: boolean;
}
