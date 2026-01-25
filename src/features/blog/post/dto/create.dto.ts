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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  authorId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  categoryId?: number;

  @IsString()
  @IsNotEmpty({ message: 'title is required' })
  title: string;

  @IsString()
  @IsNotEmpty({ message: 'slug is required' })
  slug: string;

  @IsString()
  @IsOptional()
  excerpt?: string;

  @IsString()
  @IsNotEmpty({ message: 'content is required' })
  content: string;

  @IsString()
  @IsOptional()
  coverImage?: string;

  @IsString()
  @IsNotEmpty({ message: 'status is required' })
  status: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsNotEmpty({ message: 'featured is required' })
  featured: boolean;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  publishedAt?: Date;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  viewCount?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;

  @IsOptional()
  image?: any;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((id: string) => Number(id.trim()));
    }
    return value;
  })
  tagIds?: number[];
}
