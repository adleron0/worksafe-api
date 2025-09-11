import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  courseClassId: number;

  // Os demais campos serão preenchidos automaticamente no hookPreCreate
}
