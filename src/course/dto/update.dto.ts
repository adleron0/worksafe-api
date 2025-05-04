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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  hoursDuration: number;

  @IsString()
  @IsOptional()
  flag: string;

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
  @Type(() => Boolean)
  @IsOptional()
  weekly: boolean;

  @IsString()
  @IsOptional()
  weekDays: string;

  @IsJSON()
  @IsOptional()
  faq: JSON;

  @IsJSON()
  @IsOptional()
  exam: JSON;

  @IsUrl({}, { message: 'Invalid URL format for image' })
  @IsOptional()
  imageUrl?: string | null;

  @IsOptional()
  image?: any; // Permitir que seja tratado como arquivo no Controller
}
