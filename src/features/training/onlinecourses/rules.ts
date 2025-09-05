import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';

export const noCompany = false;
export const omitAttributes = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function validateCreate(request: Request, CreateDto: any) {
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId),
    courseId: CreateDto.courseId,
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
  if (!UpdateDto.isActive) {
    UpdateDto.inactiveAt = new Date();
    UpdateDto.isActive = false;
  } else {
    UpdateDto.inactiveAt = null;
    UpdateDto.isActive = true;
  }

  // Nao permite editar o courseId
  delete UpdateDto.courseId;

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
