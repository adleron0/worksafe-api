import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { BadRequestException } from '@nestjs/common';

export const noCompany = false;
export const omitAttributes: string[] = [];

type logParams = {
  userId: string;
  companyId: string;
};

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function getSearchParams(request: Request, CreateDto: any) {
  // Para rotas públicas, usa o companyId do DTO ou busca pela turma
  // Para rotas autenticadas, usa o companyId do usuário
  const search = {
    companyId: request.user?.companyId
      ? Number(request.user.companyId)
      : CreateDto.companyId
        ? Number(CreateDto.companyId)
        : undefined,
    cpf: CreateDto.cpf,
    classId: Number(CreateDto.classId),
  };

  return search;
}

/*
 * Função para formatar campos pré-update
 * ajustes valores para update
 * ajuste valores null/booleab para quando vierem vazios
 */
export function formaterPreUpdate(UpdateDto: any) {
  // Regras automáticas para campos booleanos (geradas automaticamente)
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade

  // Exemplos de outros tipos de campos
  // if (UpdateDto.numberField === undefined) UpdateDto.numberField = 0;
  // if (UpdateDto.arrayField === undefined) UpdateDto.arrayField = [];
  // if (UpdateDto.objectField === undefined) UpdateDto.objectField = {};

  return UpdateDto;
}

// HOOKS DE PRÉ E PÓS CREATE/UPDATE

/*
 * Hook de pré criação
 */
async function hookPreCreate(params: {
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  const { dto, entity, logParams, prisma } = params;
  console.log('🚀 ~ hookPreCreate ~ dto:', dto);
  // Pesquisa a turma
  const limit = await prisma.selectFirst('courseClass', {
    where: {
      companyId: Number(logParams.companyId),
      id: Number(dto.classId),
    },
    select: {
      maxSubscriptions: true,
      name: true,
    },
  });

  // Verifica se o limite de inscrições foi atingido
  const total = await prisma.select(entity.model, {
    where: {
      companyId: Number(logParams.companyId),
      classId: Number(dto.classId),
      subscribeStatus: 'confirmed',
    },
  });
  if (total.length >= Number(limit?.maxSubscriptions)) {
    throw new BadRequestException(
      `O limite de inscrições para a turma ${limit?.name} foi atingido`,
    );
  }
  // Verifica se está confirmando a inscrição e seleciona ou cria o trainee
  if (dto.subscribeStatus === 'confirmed') {
    // Condições para buscar o trainee existente
    const whereTrainee = {
      companyId: Number(logParams.companyId),
      cpf: dto.cpf,
    };

    // Dados para criar o trainee se não existir
    const dataTrainee = {
      name: dto.name,
      cpf: dto.cpf,
      email: dto.email,
      phone: dto.phone,
      companyId: Number(logParams.companyId),
      custumerId: dto.customerId,
      occupation: dto.occupation,
    };

    // Busca ou cria o trainee
    const traineeResult = await prisma.selectOrCreate(
      'trainee',
      whereTrainee,
      dataTrainee,
      logParams,
    );

    // Atualiza o DTO com o ID do trainee
    dto.traineeId = traineeResult.data.id;

    // Define a data de confirmação se ainda não estiver definida
    if (!dto.confirmedAt) {
      dto.confirmedAt = new Date();
    }

    console.log(
      `Trainee ${traineeResult.created ? 'criado' : 'encontrado'} com ID:`,
      traineeResult.data.id,
    );
  }
}

/*
 * Hook de pós criação
 */
async function hookPosCreate(
  params: {
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  },
  created: any,
) {
  const { dto, entity } = params;
  // Personalize aqui se necessário
}

/*
 * Hook de pré update
 */
async function hookPreUpdate(params: {
  id: number;
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: logParams;
}) {
  const { id, dto, entity, logParams, prisma } = params;

  // Verifica se está confirmando a inscrição e seleciona ou cria o trainee
  if (dto.subscribeStatus === 'confirmed') {
    // Primeiro busca a subscription atual para pegar os dados completos
    const subscription = await prisma.selectOne('courseClassSubscription', {
      where: { id: Number(id) },
    });

    if (!subscription) {
      console.error('Subscription não encontrada para ID:', id);
      return;
    }

    // Condições para buscar o trainee existente
    const whereTrainee = {
      companyId: Number(dto.companyId || subscription.companyId),
      cpf: dto.cpf || subscription.cpf,
    };

    // Dados para criar o trainee se não existir
    const dataTrainee = {
      name: dto.name || subscription.name,
      cpf: dto.cpf || subscription.cpf,
      email: dto.email || subscription.email,
      phone: dto.phone || subscription.phone,
      companyId: Number(dto.companyId || subscription.companyId),
      custumerId: dto.customerId || subscription.customerId,
      occupation: dto.occupation || subscription.occupation,
    };

    // Busca ou cria o trainee
    const traineeResult = await prisma.selectOrCreate(
      'trainee',
      whereTrainee,
      dataTrainee,
      logParams,
    );

    // Atualiza o DTO com o ID do trainee
    dto.traineeId = traineeResult.data.id;

    // Define a data de confirmação se ainda não estiver definida
    if (!dto.confirmedAt) {
      dto.confirmedAt = new Date();
    }

    console.log(
      `Trainee ${traineeResult.created ? 'criado' : 'encontrado'} com ID:`,
      traineeResult.data.id,
    );
  }
}

/*
 * Hook de pós update
 */
async function hookPosUpdate(
  params: {
    id: number;
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  },
  updated: any,
) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

export const hooksCreate = {
  hookPreCreate,
  hookPosCreate,
};

export const hooksUpdate = {
  hookPreUpdate,
  hookPosUpdate,
};
