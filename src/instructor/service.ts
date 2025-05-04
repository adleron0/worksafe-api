import { Injectable } from '@nestjs/common';
import { GenericService } from 'src/generic/generic.service';
// entity template imports
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';

@Injectable()
export class InstructorService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {}
