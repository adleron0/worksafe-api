import { Type } from 'class-transformer';
import {
  IsEmail,
  IsString,
  IsInt,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsNumber,
  IsDate,
  IsJSON,
} from 'class-validator';

export class UpdateDto {


   @IsString()
    @IsOptional()
    name: string;
  
    @IsNumber()
    @IsOptional()
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
  
    @IsString()
    @IsDate()
    @IsOptional()
    initialDate?: string;
  
    @IsString()
    @IsDate()
    @IsOptional()
    finalDate?: string;
  
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
    @IsOptional()
    curriculum?: string;
  
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
}
