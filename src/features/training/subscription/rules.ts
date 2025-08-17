import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';

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
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId) || CreateDto.companyId,
    cpf: CreateDto.cpf,
    classId: CreateDto.classId,
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
  const { dto, entity } = params;
  // Personalize aqui se necessário
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
