import { IsNumber, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUserPermissionDto {
  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Precisa do ID do usuário' })
  userId: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Precisa do ID da permissão' })
  permissionId: number;
}
