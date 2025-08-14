import { Injectable } from '@nestjs/common';
import { GenericService } from 'src/features/generic/generic.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { InvalidateAuthCache } from 'src/common/cache/auth-cache.decorator';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';

@Injectable()
export class ProfileService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    private readonly authCache: AuthCacheService,
  ) {
    super(prisma, null);
  }

  @InvalidateAuthCache('profile', (args) => args[0])
  async update(
    id: number,
    dto: UpdateDto,
    logParams: any,
    entity: any,
    file?: Express.MulterS3.File,
    hooks?: any,
  ): Promise<IEntity> {
    return super.update(id, dto, logParams, entity, file, hooks);
  }

  @InvalidateAuthCache('profile', (args) => args[0])
  async changeStatus(
    id: number,
    type: string,
    logParams: any,
    entity: any,
  ): Promise<IEntity> {
    return super.changeStatus(id, type, logParams, entity);
  }
}
