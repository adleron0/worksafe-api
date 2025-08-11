import { GenericService } from 'src/features/generic/generic.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaClient } from '@prisma/client';

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

@Injectable()
export class ExamesService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
  }

  /**
   * Método para cadastrar exame com validação de trainee
   * Verifica se o trainee existe e está confirmado em alguma inscrição
   */
  async registerExam(dto: CreateDto, entity: entity) {
    try {
      // Validar se o traineeId foi fornecido
      if (!dto.traineeId) {
        throw new BadRequestException('ID do aluno é obrigatório');
      }

      // Buscar o trainee para validar se existe
      const trainee = await this.prisma.selectOne('trainee', {
        where: {
          id: Number(dto.traineeId),
        },
      });

      if (!trainee) {
        throw new NotFoundException('Aluno não encontrado');
      }

      // Verificar se o trainee tem alguma inscrição confirmada
      const confirmedSubscription = await this.prisma.selectFirst(
        'courseClassSubscription',
        {
          where: {
            traineeId: Number(dto.traineeId),
            subscribeStatus: 'confirmed',
            inactiveAt: null,
          },
          include: {
            class: {
              include: {
                course: true,
              },
            },
          },
        },
      );

      if (!confirmedSubscription) {
        throw new BadRequestException(
          'Aluno não possui inscrição confirmada em nenhuma turma',
        );
      }

      // Se passou pelas validações, criar o exame
      const logParams = {
        userId: 0, // Sistema/público
        companyId: confirmedSubscription.companyId,
      };

      // Adicionar informações adicionais ao DTO
      dto.companyId = confirmedSubscription.companyId;
      dto.classId = confirmedSubscription.classId;
      dto.courseId = confirmedSubscription.class.courseId;

      // Verificar se já existe um exame para este trainee nesta turma
      const existingExam = await this.prisma.selectFirst(entity.model, {
        where: {
          traineeId: Number(dto.traineeId),
          classId: confirmedSubscription.classId,
          inactiveAt: null,
        },
      });

      if (existingExam) {
        throw new BadRequestException(
          `Aluno já possui exame cadastrado para a turma ${confirmedSubscription.class.name}`,
        );
      }

      // Criar o exame
      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      return {
        success: true,
        message: 'Exame cadastrado com sucesso',
        data: created,
        subscription: {
          classId: confirmedSubscription.classId,
          className: confirmedSubscription.class.name,
          courseName: confirmedSubscription.class.course.name,
        },
      };
    } catch (error) {
      console.log('🚀 ~ ExamesService ~ registerExam ~ error:', error);
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Erro ao cadastrar exame');
    }
  }
}
