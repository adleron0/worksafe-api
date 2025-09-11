import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';

export const noCompany = true;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields = false;

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criação
 */
export function getSearchParams(request: Request, CreateDto: any) {
  // Para student-certificates, usamos o traineeId do contexto do aluno
  const traineeId = request['traineeId'];

  const search = {
    traineeId: traineeId,
    courseId: CreateDto.courseId,
    courseClassId: CreateDto.courseClassId,
  };

  return search;
}

/*
 * Função para formatar campos pré-update
 * ajustes valores para update
 * ajuste valores null/boolean para quando vierem vazios
 */
export function formaterPreUpdate(UpdateDto: any) {
  // Personalize conforme necessário
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
  const { dto, entity, prisma } = params;

  // Validar se o aluno tem permissão para gerar certificado
  if (dto.traineeId && dto.courseClassId) {
    const enrollment = await prisma.selectFirst('courseClassSubscription', {
      where: {
        traineeId: dto.traineeId,
        classId: dto.courseClassId,
        subscribeStatus: 'approved',
      },
    });

    if (!enrollment) {
      throw new Error('Aluno não está inscrito nesta turma');
    }
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
  logParams: any;
}) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
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
