import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';

export const noCompany = true;
export const omitAttributes: string[] = [
  'id',
  'financial_email',
  'financial_contact',
];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

// HOOKS DE PRÉ E PÓS CREATE/UPDATE
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
  const { id, dto, entity, logParams } = params;
  // Verifica se o token do usuário pertence à empresa que está sendo atualizada
  if (Number(logParams.companyId) !== Number(id)) {
    throw new Error('Você não tem permissão para atualizar esta empresa.');
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

export const hooksUpdate = {
  hookPreUpdate,
  hookPosUpdate,
};
