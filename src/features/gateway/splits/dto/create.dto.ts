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
  @IsNotEmpty({ message: 'financialRecordId is required' })
  financialRecordId: number;

  @IsString()
  @IsNotEmpty({ message: 'toWalletId is required' })
  toWalletId: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'sellerId is required' })
  sellerId: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'originalValue is required' })
  originalValue: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'splitValue is required' })
  splitValue: number;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  splitPercentage?: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'netValue is required' })
  netValue: number;

  @IsString()
  @IsOptional()
  splitDescription?: string;

  @IsString()
  @IsNotEmpty({ message: 'status is required' })
  status: string;

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
  @IsNotEmpty({ message: 'hasDivergence is required' })
  hasDivergence: boolean;

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
}
