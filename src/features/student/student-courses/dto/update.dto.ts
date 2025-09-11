import { IsOptional, IsString, IsBoolean, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  accepted?: boolean;

  @IsOptional()
  @IsDateString()
  acceptedAt?: string;

  @IsOptional()
  @IsDateString()
  declinedAt?: string;

  @IsOptional()
  @IsString()
  declinedReason?: string;
}
