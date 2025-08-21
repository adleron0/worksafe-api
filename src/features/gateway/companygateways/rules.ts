import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { CacheService } from 'src/common/cache/cache.service';

export const noCompany = false;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

// Variáveis para armazenar os serviços
let asaasServiceInstance: AsaasService;
let cacheServiceInstance: CacheService;

// Funções para configurar os serviços (serão chamadas pelo controller)
export function setAsaasService(service: AsaasService) {
  asaasServiceInstance = service;
}

export function setCacheService(service: CacheService) {
  cacheServiceInstance = service;
}

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function getSearchParams(request: Request, CreateDto: any) {
  // Exemplo de search usando companyId do request e campos do dto
  // PERSONALIZE ESTA FUNÇÃO conforme as necessidades da sua entidade
  const search = {
    companyId: Number(request.user?.companyId),
    gateway: CreateDto.gateway,
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
  const { dto, entity, prisma, logParams } = params;
  // Se for gateway Asaas e tiver payload com token
  if (dto.gateway === 'asaas' && dto.payload) {
    let payloadData = dto.payload;

    // Se payload for string, fazer parse
    if (typeof payloadData === 'string') {
      try {
        payloadData = JSON.parse(payloadData);
      } catch {
        payloadData = dto.payload;
      }
    }

    // Se tiver token e o serviço Asaas estiver disponível, configurar webhook
    if (payloadData.token && asaasServiceInstance && cacheServiceInstance) {
      try {
        // Primeiro salva o token no Redis para que o webhook possa ser configurado
        const cacheKey = `asaasToken:${logParams.companyId}`;
        await cacheServiceInstance.set(cacheKey, payloadData.token, 3600);
        console.log('📝 Token Asaas salvo no cache Redis');

        // Agora configura o webhook no Asaas
        const webhookData = await asaasServiceInstance.configureWebhooks(
          Number(logParams.companyId),
          payloadData.webhookId || null,
        );

        // Atualiza o payload com o ID do webhook criado
        if (webhookData && webhookData.id) {
          payloadData.webhookId = webhookData.id;
          dto.payload = payloadData;
          console.log(
            '✅ Webhook Asaas configurado com sucesso:',
            webhookData.id,
          );
        }
      } catch (error) {
        console.error('❌ Erro ao configurar webhook Asaas:', error);
        // Não bloqueia a criação, apenas loga o erro
      }
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
  const { id, dto, entity, prisma, logParams } = params;

  // Busca o registro atual para comparação
  const currentRecord = await prisma.selectFirst('companyGateWays', {
    where: {
      id: Number(id),
    },
  });

  if (!currentRecord) {
    throw new BadRequestException('Gateway não encontrada');
  }

  // Se for gateway Asaas e tiver payload com token
  if (currentRecord.gateway === 'asaas' && dto.payload) {
    let payloadData = dto.payload;
    let currentPayload = currentRecord.payload || {};

    // Se payload for string, fazer parse
    if (typeof payloadData === 'string') {
      try {
        payloadData = JSON.parse(payloadData);
      } catch {
        payloadData = dto.payload;
      }
    }

    // Se payload atual for string, fazer parse
    if (typeof currentPayload === 'string') {
      try {
        currentPayload = JSON.parse(currentPayload);
      } catch {
        currentPayload = {};
      }
    }

    // Se tiver token e o serviço Asaas estiver disponível, atualizar ou criar webhook
    if (payloadData.token && asaasServiceInstance && cacheServiceInstance) {
      try {
        // Atualiza o token no Redis se foi alterado
        const cacheKey = `asaasToken:${logParams.companyId}`;
        await cacheServiceInstance.set(cacheKey, payloadData.token, 3600);
        console.log('📝 Token Asaas atualizado no cache Redis');

        // Configura ou atualiza o webhook no Asaas
        const webhookData = await asaasServiceInstance.configureWebhooks(
          Number(logParams.companyId),
          currentPayload.webhookId || payloadData.webhookId || null,
        );

        // Atualiza o payload com o ID do webhook
        if (webhookData && webhookData.id) {
          payloadData.webhookId = webhookData.id;
          dto.payload = payloadData;
          console.log(
            '✅ Webhook Asaas atualizado com sucesso:',
            webhookData.id,
          );
        }
      } catch (error) {
        console.error('❌ Erro ao atualizar webhook Asaas:', error);
        // Não bloqueia a atualização, apenas loga o erro
      }
    }
  }

  // Se estiver desativando (active = false), adiciona inactiveAt
  if (dto.active === false && currentRecord.active === true) {
    dto.inactiveAt = new Date();
  }

  // Se estiver reativando (active = true), remove inactiveAt
  if (dto.active === true && currentRecord.active === false) {
    dto.inactiveAt = null;
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
