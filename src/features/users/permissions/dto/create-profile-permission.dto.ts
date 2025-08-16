import { IsNumber, IsNotEmpty } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateProfilePermissionDto {
  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Precisa do ID do perfil' })
  profileId: number;

  @IsNumber()
  @Type(() => Number)
  @IsNotEmpty({ message: 'Precisa do ID da permissão' })
  permissionId: number;
}
