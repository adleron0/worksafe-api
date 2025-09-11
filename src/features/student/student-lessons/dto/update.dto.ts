import { IsOptional, IsNumber, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  progress?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  completed?: boolean;
}
