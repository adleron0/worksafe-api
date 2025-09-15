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
  @IsString()
  @IsNotEmpty({ message: 'code is required' })
  code: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  sellerId?: number;

  @IsString()
  @IsNotEmpty({ message: 'discountType is required' })
  discountType: string;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'discountValue is required' })
  discountValue: number;

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
  @IsNotEmpty({ message: 'usageCount is required' })
  usageCount: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'usagePerCustomer is required' })
  usagePerCustomer: number;

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
  @IsNotEmpty({ message: 'firstPurchaseOnly is required' })
  firstPurchaseOnly: boolean;

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
  @IsNotEmpty({ message: 'active is required' })
  active: boolean;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
