import { Type, Transform } from 'class-transformer';
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
  @IsInt()
  @Type(() => Number)
  @IsOptional()
  id: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId: number;

  @IsBoolean()
  @IsOptional()
  active: boolean;

  @IsString()
  @IsOptional()
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  hoursDuration: number;

  @IsString()
  @IsOptional()
  flags: string;

  @IsString()
  @IsOptional()
  icon: string;

  @IsString()
  @IsOptional()
  color: string;

  @IsString()
  @IsOptional()
  description: string;

  @IsString()
  @IsOptional()
  gradeTheory: string;

  @IsString()
  @IsOptional()
  gradePracticle: string;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  weekly: boolean;

  @IsString()
  @IsOptional()
  weekDays: string;

  @IsJSON()
  @IsOptional()
  faq: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  yearOfValidation: number;

  @IsJSON()
  @IsOptional()
  exam: JSON;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  media: number;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
