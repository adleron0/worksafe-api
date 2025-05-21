import { IsString, IsNotEmpty } from 'class-validator';

export class CreateDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;
}
