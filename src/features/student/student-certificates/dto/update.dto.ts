import { IsOptional, IsNumber, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  grade?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  certificateUrl?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: Date;
}
