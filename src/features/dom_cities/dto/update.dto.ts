import { IsString, IsOptional, IsInt } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class UpdateDto {
  @IsString()
  @IsOptional()
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsOptional()
  stateId: number;
}
