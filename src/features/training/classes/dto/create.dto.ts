import { Type } from 'class-transformer';
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
  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  name: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  price?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  companyId?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  courseId?: string;

  @IsDate()
  @IsOptional()
  @Type(() => Date)
  initialDate?: Date;

  @IsDate()
  @IsOptional()
  @Type(() => Date)
  finalDate?: Date;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  customerId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  oldPrice?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  hoursDuration?: number;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  openClass?: boolean;

  @IsString()
  @IsOptional()
  gifts?: string;

  @IsString()
  @IsNotEmpty({ message: 'gradeTheory is required' })
  gradeTheory: string;

  @IsString()
  @IsNotEmpty({ message: 'gradePracticle is required' })
  gradePracticle: string;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsUrl({}, { message: 'Invalid URL format for video' })
  @IsOptional()
  videoUrl?: string;

  @IsString()
  @IsOptional()
  videoTitle?: string;

  @IsString()
  @IsOptional()
  videoSubtitle?: string;

  @IsString()
  @IsOptional()
  videoDescription?: string;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  active?: boolean;

  @IsJSON()
  @IsOptional()
  faq?: string;

  @IsString()
  @IsOptional()
  landingPagesDates?: string;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  allowExam?: boolean;

  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  allowReview?: boolean;

  @IsOptional()
  image?: any;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  minimumQuorum?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  maxSubscriptions?: number;
}
