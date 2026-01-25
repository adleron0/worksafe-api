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
  @IsOptional()
  companyId?: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'postId is required' })
  postId: number;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  parentId?: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'depth is required' })
  depth: number;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'visitorId is required' })
  visitorId: number;

  @IsString()
  @IsNotEmpty({ message: 'content is required' })
  content: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  rating?: number;

  @IsString()
  @IsNotEmpty({ message: 'status is required' })
  status: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  inactiveAt?: Date;
}
