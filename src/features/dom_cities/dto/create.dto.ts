import { IsString, IsNotEmpty, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @IsInt()
  @Type(() => Number)
  @IsNotEmpty({ message: 'State ID is required' })
  stateId: number;
}
