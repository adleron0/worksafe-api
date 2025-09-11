import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  courseId: number;

  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  courseClassId: number;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  grade?: number;

  @IsOptional()
  @IsString()
  certificateNumber?: string;
}
