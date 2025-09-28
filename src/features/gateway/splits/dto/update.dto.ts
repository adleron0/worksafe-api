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

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  financialRecordId?: number;

  @IsString()
  @IsOptional()
  toWalletId?: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  sellerId?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  originalValue?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  splitValue?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  splitPercentage?: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  netValue?: number;

  @IsString()
  @IsOptional()
  splitDescription?: string;

  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  asaasSplitId?: string;

  @IsString()
  @IsOptional()
  asaasTransferId?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  processedAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  settledAt?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  withdrawnAt?: Date;

  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  hasDivergence?: boolean;

  @IsString()
  @IsOptional()
  divergenceReason?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  divergenceResolvedAt?: Date;

  @IsJSON()
  @IsOptional()
  gatewayResponse?: JSON;

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
}
