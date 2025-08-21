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
  @IsNotEmpty({ message: 'accrualDate is required' })
  accrualDate: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  companyId?: number;

  @IsString()
  @IsNotEmpty({ message: 'gateway is required' })
  gateway: string;

  @IsString()
  @IsNotEmpty({ message: 'status is required' })
  status: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  subscriptionId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  traineeId?: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  customerId?: number;

  @IsString()
  @IsNotEmpty({ message: 'paymentMethod is required' })
  paymentMethod: string;

  @IsNumber()
  @Type(() => Number)
  @IsOptional()
  value?: number;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  dueDate?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  paidAt?: Date;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  billUrl?: string;

  @IsString()
  @IsOptional()
  billNumber?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Invalid URL format' })
  pixUrl?: string;

  @IsString()
  @IsOptional()
  pixNumber?: string;

  @IsJSON()
  @IsOptional()
  requestData?: JSON;

  @IsJSON()
  @IsOptional()
  responseData?: JSON;

  @IsJSON()
  @IsOptional()
  errorData?: JSON;

  @IsString()
  @IsOptional()
  observations?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  externalId?: string;

  @IsString()
  @IsNotEmpty({ message: 'key is required' })
  key: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
