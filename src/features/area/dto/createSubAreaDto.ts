import { Type, Transform } from 'class-transformer';
import { IsString, IsNotEmpty, IsInt } from 'class-validator';

export class CreateSubAreaDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsInt()
  @Type(() => Number) // Garantir conversão para número ao usar class-transformer
  @IsNotEmpty({ message: 'Area ID is required' })
  areaId: number;
}
