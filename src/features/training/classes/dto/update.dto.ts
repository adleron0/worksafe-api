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
  IsEnum,
  IsArray,
} from 'class-validator';
import { paymentMethods } from '@prisma/client';

export class UpdateDto {
  @IsString()
  @IsOptional()
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
  companyId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  courseId?: number;

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

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  daysDuration?: number;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  openClass?: boolean;

  @IsString()
  @IsOptional()
  gifts?: string;

  @IsString()
  @IsOptional()
  gradeTheory: string;

  @IsString()
  @IsOptional()
  gradePracticle: string;

  @IsOptional()
  @Transform(({ value }) => {
    // Se não há valor ou é string vazia, retorna undefined para ser preenchido depois
    if (!value || value === '') {
      return undefined;
    }
    // Se tem valor, valida se é uma URL válida
    if (value && typeof value === 'string' && value.length > 0) {
      try {
        new URL(value);
        return value;
      } catch {
        console.warn('⚠️ imageUrl inválida no update, será ignorada:', value);
        return undefined;
      }
    }
    return value;
  })
  imageUrl?: string | null;

  @IsOptional()
  @Transform(({ value }) => {
    if (!value || value === '' || value === null) {
      return undefined;
    }
    return value;
  })
  @IsUrl({}, { message: 'Invalid URL format for video' })
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

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  allowCheckout?: boolean;

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
    if (!value) return [];
    if (typeof value === 'string') {
      return value.split(',').map((item) => item.trim());
    }
    return value;
  })
  paymentMethods?: paymentMethods[];

  @IsJSON()
  @IsOptional()
  whyUs?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  allowSubscriptions?: boolean;

  @IsString()
  @IsOptional()
  periodSubscriptionsType?: string;

  @IsDate()
  @IsOptional()
  @Type(() => Date)
  periodSubscriptionsInitialDate?: Date;

  @IsDate()
  @IsOptional()
  @Type(() => Date)
  periodSubscriptionsFinalDate?: Date;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  unlimitedSubscriptions?: boolean;

  @IsString()
  @IsOptional()
  periodClass?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  hasOnlineCourse?: boolean;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  onlineCourseModelId?: number;

  // Campos de endereço
  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  addressNumber?: string;

  @IsString()
  @IsOptional()
  addressComplement?: string;

  @IsString()
  @IsOptional()
  neighborhood?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  state?: string;

  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.replace(/[^\d]/g, ''))
  zipCode?: string;
}
