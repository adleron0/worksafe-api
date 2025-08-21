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
  IsEnum,
  IsArray,
} from 'class-validator';
import { paymentMethods } from '@prisma/client';

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
  certificateId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  discountPrice?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  dividedIn?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  hoursDuration?: number;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  openClass?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  allowCheckout?: boolean;

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
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  active?: boolean;

  @IsJSON()
  @IsOptional()
  faq?: string;

  @IsString()
  @IsOptional()
  landingPagesDates?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  allowExam?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
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

  @IsString()
  @IsOptional()
  classCode?: string;

  @IsArray()
  @IsEnum(paymentMethods, { each: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((item) => item.trim());
    }
    return value;
  })
  paymentMethods?: paymentMethods[];
}
