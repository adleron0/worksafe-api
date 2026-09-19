import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
 
export const noCompany = false;
export const omitAttributes: string[] = [];


/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function validateCreate(request: Request, CreateDto: any) {
  return {
    companyId: Number(request.user?.companyId),
    slug: CreateDto.slug,
    inactiveAt: null,
  };
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
  if (UpdateDto.featured === undefined) UpdateDto.featured = false;


  
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
  const { dto, logParams } = params;

  // Define authorId do usuário logado
  if (!dto.authorId) {
    dto.authorId = Number(logParams.userId);
  }

  // Define viewCount padrão
  if (dto.viewCount === undefined) {
    dto.viewCount = 0;
  }

  // Define publishedAt automaticamente quando status for published
  if (dto.status === 'published' && !dto.publishedAt) {
    dto.publishedAt = new Date();
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
  // Tags são gerenciadas diretamente no controller
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
  const { dto, prisma, id } = params;

  // Se está mudando para published, define publishedAt automaticamente
  if (dto.status === 'published') {
    const current = await prisma.blog_Post.findUnique({ where: { id: Number(id) } });
    // Só define publishedAt se ainda não tiver (primeira publicação)
    if (current && !current.publishedAt) {
      dto.publishedAt = new Date();
    }
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
