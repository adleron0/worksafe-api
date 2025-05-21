import { IsString, IsOptional, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateDto {
  @IsString()
  @IsOptional()
  name: string;

  @IsString()
  @IsOptional()
  color: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;
}
