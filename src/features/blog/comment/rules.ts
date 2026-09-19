import { PrismaService } from 'src/prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

export const noCompany = false;
export const omitAttributes: string[] = [];


/*
 * Função de search personalizada para verificação antes de criar
 * Comentários não precisam de verificação de duplicata
 */
export function validateCreate(request: Request, CreateDto: any) {
  // Validar profundidade máxima
  if (CreateDto.depth > 2) {
    throw new BadRequestException('Profundidade máxima de comentários é 2');
  }

  // Retorna null para não verificar duplicata (permite múltiplos comentários)
  return null;
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
  const { dto, prisma } = params;

  // Verificar se já existe rating do mesmo visitante para o mesmo post
  if (dto.rating) {
    const existingRating = await prisma.blog_Comment.findFirst({
      where: {
        postId: dto.postId,
        visitorId: dto.visitorId,
        rating: { not: null },
        inactiveAt: null,
      },
    });

    if (existingRating) {
      throw new BadRequestException('Você já avaliou este post');
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
