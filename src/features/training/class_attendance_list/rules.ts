import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
 
export const noCompany = false;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function getSearchParams(request: Request, CreateDto: any) {
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId),
    // Adicione aqui os campos que devem ser únicos por empresa
    // Exemplo: name: CreateDto.name,
    // Exemplo: email: CreateDto.email,
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
  
    // Campos booleanos detectados automaticamente
  if (UpdateDto.IsPresent === undefined) UpdateDto.IsPresent = false;


  
  // Exemplos de outros tipos de campos
  // if (UpdateDto.numberField === undefined) UpdateDto.numberField = 0;
  // if (UpdateDto.arrayField === undefined) UpdateDto.arrayField = [];
  // if (UpdateDto.objectField === undefined) UpdateDto.objectField = {};
  
  return UpdateDto;
}

/*
 * Função para definir whereCondition do upsert
 * Define campos únicos para identificar registro existente
 */
export function getUpsertWhereCondition(request: Request, dto: any) {
  // IMPORTANTE: O Prisma precisa de um campo único (id) ou índice único composto
  // Como não temos índice único composto, usamos um id impossível
  // O PrismaService fará a busca pelos campos e retornará o id correto se existir
  
  return {
    companyId: Number(request.user?.companyId),
    classId: Number(dto.classId),
    traineeId: Number(dto.traineeId),
    day: Number(dto.day),
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
  logParams: any 
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
    logParams: any 
  },
  created: any
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
  logParams: any 
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
    logParams: any 
  }, 
  updated: any
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
  logParams: any 
}) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
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
    logParams: any 
  }, 
  upserted: any
) {
  const { id, dto, entity } = params;
  // Personalize aqui se necessário
}

export const hooksUpsert = {
  hookPreUpsert,
  hookPosUpsert,
};
