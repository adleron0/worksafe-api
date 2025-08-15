import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';

export const noCompany = true;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields = ['variableToReplace'];

// Se quiser adicionar campos de relações no futuro:
// export const encryptFields = [
//   'variableToReplace',        // Campo da entidade principal
//   'trainee.cpf',              // Campo da relação trainee
//   'trainee.rg',               // Campo da relação trainee
//   'company.cnpj',             // Campo da relação company
// ];

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function getSearchParams(request: Request, CreateDto: any) {
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId),
    courseId: CreateDto.courseId,
    traineeId: CreateDto.traineeId,
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
