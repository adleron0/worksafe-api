import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { BadRequestException } from '@nestjs/common';

export const noCompany = false;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function validateCreate(request: Request, CreateDto: any) {
  throw new BadRequestException('Não implementado');
}

/*
 * Função para formatar campos pré-update
 * ajustes valores para update
 * ajuste valores null/booleab para quando vierem vazios
 */
export function formaterPreUpdate(UpdateDto: any) {
  return {};
}

/*
 * Função para definir whereCondition do upsert
 * Define campos únicos para identificar registro existente
 */
export function getUpsertWhereCondition(request: Request, dto: any) {
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  // Defina os campos únicos para identificar registros existentes

  return {
    companyId: Number(request.user?.companyId),
    modelId: dto.modelId,
    lessonId: dto.lessonId,
  };
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

/*
 * Hook de pré upsert
 */
async function hookPreUpsert(params: {
  id: number;
  dto: any;
  entity: any;
  prisma: PrismaService;
  logParams: any;
}) {
  const { id, dto, entity } = params;
  if (!dto.isActive) {
    dto.inactiveAt = new Date();
    dto.isActive = false;
  } else {
    dto.inactiveAt = null;
    dto.isActive = true;
  }
}

/*
 * Hook de pós upsert
 */
async function hookPosUpsert(
  params: {
    id: number;
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  },
  upserted: any,
) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

export const hooksUpsert = {
  hookPreUpsert,
  hookPosUpsert,
};
