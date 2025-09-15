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
  id?: number;

  @IsString()
  @IsOptional()
  code?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  sellerId?: number;

  @IsString()
  @IsOptional()
  discountType?: string;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  discountValue?: number;

  @IsString()
  @IsOptional()
  commissionType?: string;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  commissionValue?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  minPurchaseValue?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  maxDiscountValue?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  usageLimit?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  usageCount?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  usagePerCustomer?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  validFrom?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  validUntil?: Date;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  firstPurchaseOnly?: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  classId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  courseId?: number;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  active?: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  createdAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  updatedAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
