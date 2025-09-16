import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AlunosService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(protected prisma: PrismaService) {
    super(prisma, null);
  }

  /**
   * Busca ou cria um trainee com base nos dados fornecidos
   * @param subscriptionData - Dados da inscrição contendo informações do aluno
   * @param companyId - ID da empresa
   * @param subscriptionId - ID da inscrição (opcional, para log)
   * @returns ID do trainee encontrado ou criado
   */
  async findOrCreateTrainee(
    subscriptionData: any,
    companyId: number,
    subscriptionId?: number,
  ): Promise<number> {
    // Usa selectOrCreate para buscar ou criar o trainee
    // NOTA: trainee não tem campos neighborhood, city, state como strings
    // Esses campos ficam apenas na subscription
    const traineeData = {
      name: subscriptionData.name,
      cpf: subscriptionData.cpf,
      email: subscriptionData.email,
      phone: subscriptionData.phone,
      occupation: subscriptionData.occupation || null,
      address: subscriptionData.address || null,
      addressNumber: subscriptionData.addressNumber
        ? String(subscriptionData.addressNumber)
        : null,
      complement:
        subscriptionData.addressComplement ||
        subscriptionData.complement ||
        null,
      zipCode: subscriptionData.zipCode || null,
    };

    // Corrigindo a estrutura para selectOrCreate
    const whereCondition = {
      cpf: subscriptionData.cpf,
    };

    const trainee = await this.prisma.selectOrCreate(
      'trainee',
      whereCondition,
      traineeData,
      { companyId }, // logParams com companyId
    );

    // cria relacionamento trainee empresa
    await this.prisma.upsert(
      'traineeCompany',
      {
        traineeId: trainee.data.id,
        companyId: companyId,
      },
      {
        where: {
          traineeId: trainee.data.id,
          companyId: companyId,
        },
      },
      { companyId }, // logParams com companyId
    );

    if (trainee.created) {
      console.log(`Trainee criado: ${trainee.data.id} - ${trainee.data.name}`);
    } else {
      console.log(
        `Trainee existente encontrado: ${trainee.data.id} - ${trainee.data.name}`,
      );
    }

    return trainee.data.id;
  }
}
