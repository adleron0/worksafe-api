import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsObject,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  lessonId: number;

  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  courseClassId: number;

  @IsOptional()
  @IsString()
  evaluationType?: string;

  @IsOptional()
  @IsObject()
  answers?: any;
}
