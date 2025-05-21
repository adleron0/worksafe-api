import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateAreaDto } from './dto/createArea.dto';
import { UpdateAreaDto } from './dto/updateArea.dto';
import { Area } from './interfaces/area.interface';
import { SubArea } from './interfaces/subarea.interface';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CreateSubAreaDto } from './dto/createSubAreaDto';

@Injectable()
export class AreaService {
  constructor(
    private prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

  async create(
    createAreaDto: CreateAreaDto,
    logParams: any,
    file?: Express.MulterS3.File,
  ): Promise<Area> {
    const verifyExistingArea = await this.prisma.selectOne('area', {
      where: {
        name_companyId: {
          name: createAreaDto.name,
          companyId: Number(createAreaDto.companyId),
        },
      },
    });
    if (verifyExistingArea) {
      throw new BadRequestException('Área já cadastrado nesta empresa');
    }

    const area = await this.prisma.insert(
      'area',
      {
        ...createAreaDto,
        imageUrl: file ? file.location : null,
      },
      logParams,
    );

    return area;
  }

  async createSubArea(createSubAreaDto: CreateSubAreaDto): Promise<SubArea> {
    const verifyExistingSubArea = await this.prisma.subArea.findUnique({
      where: {
        name_areaId: {
          name: createSubAreaDto.name,
          areaId: Number(createSubAreaDto.areaId),
        },
      },
    });
    if (verifyExistingSubArea) {
      throw new BadRequestException('SubArea já cadastrado nesta área');
    }

    const subarea = await this.prisma.subArea.create({
      data: {
        ...createSubAreaDto,
      },
    });

    return subarea;
  }

  async findAll(filters: any) {
    const where: any = {};

    // Aplicando os filtros adicionais corretamente
    if (filters.name)
      where.name = { contains: filters.name, mode: 'insensitive' };
    if (filters.active === 'true') where.inactiveAt = null;
    if (filters.active === 'false') where.inactiveAt = { not: null };

    if (filters?.createdAt?.length === 1) {
      where.createdAt = new Date(filters.createdAt[0]);
    } else if (filters?.createdAt?.length === 2) {
      where.createdAt = {
        gte: new Date(filters.createdAt[0]),
        lte: new Date(filters.createdAt[1]),
      };
    }

    // Definindo valores padrão para página e limite
    const page = filters.page ? Number(filters.page) + 1 : 1;
    const limit = filters.limit ? Number(filters.limit) : 10;

    // Calculando o número de itens a serem pulados (skip) com base na página atual
    const skip = (page - 1) * limit;

    // Executando as consultas em paralelo para otimizar a performance
    const [areas, total] = await Promise.all([
      this.prisma.area.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          subarea: false,
        },
      }),
      this.prisma.area.count({ where }),
    ]);

    // Retornando a lista de areas e a contagem total
    return {
      total,
      areas,
    };
  }

  async update(
    areaId: string,
    updateAreaDto: UpdateAreaDto,
    file?: Express.MulterS3.File,
  ): Promise<Area> {
    const existingArea = await this.prisma.area.findUnique({
      where: { id: Number(areaId) },
    });

    if (!existingArea) {
      throw new NotFoundException('Área não encontrado');
    }

    // Se uma nova imagem foi enviada, exclui a imagem antiga e define a nova URL
    if (file) {
      if (existingArea.imageUrl) {
        await this.uploadService.deleteImageFromS3(existingArea.imageUrl);
      }
      updateAreaDto.imageUrl = file.location;
    }

    // Se `updateAreaDto.imageUrl` é null e não há nova imagem, exclui a imagem existente
    if (!updateAreaDto.imageUrl && !file && existingArea.imageUrl) {
      await this.uploadService.deleteImageFromS3(existingArea.imageUrl);
      updateAreaDto.imageUrl = null;
    }

    const updateArea = await this.prisma.area.update({
      where: { id: Number(areaId) },
      data: {
        ...updateAreaDto,
        imageUrl: updateAreaDto.imageUrl ?? null,
        companyId: Number(updateAreaDto.companyId),
      },
    });

    return updateArea;
  }

  async findOne(areaId: string): Promise<Area> {
    const area = await this.prisma.area.findUnique({
      where: {
        id: Number(areaId),
      },
    });

    return area;
  }

  async inactivateArea(areaId: string): Promise<Area> {
    const verifyArea = await this.prisma.area.findUnique({
      where: {
        id: Number(areaId),
      },
    });
    if (!verifyArea) {
      throw new NotFoundException('Área não encontrada');
    }
    const area = await this.prisma.area.update({
      where: {
        id: Number(areaId),
      },
      data: {
        updatedAt: new Date(),
        inactiveAt: new Date(),
      },
    });

    return area;
  }

  async activateArea(areaId: string): Promise<Area> {
    const verifyArea = await this.prisma.area.findUnique({
      where: {
        id: Number(areaId),
      },
    });
    if (!verifyArea) {
      throw new NotFoundException('Área não encontrada');
    }
    const area = await this.prisma.area.update({
      where: {
        id: Number(areaId),
      },
      data: {
        updatedAt: new Date(),
        inactiveAt: null,
      },
    });
    return area;
  }
}
