import { IsOptional, IsNumber, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  progressPercent?: number;

  @IsOptional()
  @Transform(({ value }) => {
    // Se vier como string (FormData), fazer parse
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return value || {};
  })
  @IsObject()
  progressData?: any;
}
