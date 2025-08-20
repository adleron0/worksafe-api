import { Type, Transform } from 'class-transformer';
import { IsString, IsOptional, IsInt, IsUrl, MinLength } from 'class-validator';

export class UpdateAreaDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsOptional()
  imageUrl?: string | null;

  @IsString()
  @MinLength(10, { message: 'Description must have at least 10 characters' })
  @IsOptional()
  description?: string | null;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;
}
