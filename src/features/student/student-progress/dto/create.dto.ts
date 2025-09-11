import { IsNotEmpty, IsNumber, IsOptional, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  stepId: number;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  progressPercent?: number;

  @IsOptional()
  @IsObject()
  progressData?: any;
}
