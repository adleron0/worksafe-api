import { IsNotEmpty, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  lessonId: number;
}
