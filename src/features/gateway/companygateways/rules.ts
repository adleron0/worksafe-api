import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { CacheService } from 'src/common/cache/cache.service';
import { GatewayFactory } from 'src/common/gateways/gateway.factory';
import { gateways } from '@prisma/client';

export const noCompany = false;
export const omitAttributes: string[] = [];

let asaasServiceInstance: AsaasService;
let cacheServiceInstance: CacheService;
let gatewayFactoryInstance: GatewayFactory;

// Funções para configurar os serviços (serão chamadas pelo controller)
export function setAsaasService(service: AsaasService) {
  asaasServiceInstance = service;
}

export function setCacheService(service: CacheService) {
  cacheServiceInstance = service;
}

export function setGatewayFactory(factory: GatewayFactory) {
  gatewayFactoryInstance = factory;
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

  // Processa o payload se existir
  if (dto.payload) {
    let payloadData = dto.payload;

    // Se payload for string, fazer parse
    if (typeof payloadData === 'string') {
      try {
        payloadData = JSON.parse(payloadData);
      } catch {
        payloadData = dto.payload;
      }
    }

    // Configuração específica por gateway
    await configureGatewayWebhook({
      gateway: dto.gateway as gateways,
      payloadData,
      companyId: Number(logParams.companyId),
      dto,
      isUpdate: false,
    });
  }
}

/**
 * Configura webhook de acordo com o gateway
 */
async function configureGatewayWebhook(params: {
  gateway: gateways;
  payloadData: any;
  companyId: number;
  dto: any;
  isUpdate: boolean;
  currentWebhookId?: string;
}) {
  const { gateway, payloadData, companyId, dto, isUpdate, currentWebhookId } =
    params;

  switch (gateway) {
    case 'asaas':
      if (payloadData.token && asaasServiceInstance && cacheServiceInstance) {
        try {
          // Salva o token no Redis
          const cacheKey = `asaasToken:${companyId}`;
          await cacheServiceInstance.set(cacheKey, payloadData.token, 2592000);
          console.log(`📝 Token ${gateway} salvo no cache Redis`);

          // Configura o webhook
          const webhookData = await asaasServiceInstance.configureWebhooks(
            companyId,
            currentWebhookId || payloadData.webhookId || null,
          );

          // Atualiza o payload com o ID do webhook
          if (webhookData && webhookData.id) {
            payloadData.webhookId = webhookData.id;
            dto.payload = payloadData;
            console.log(
              `✅ Webhook ${gateway} ${isUpdate ? 'atualizado' : 'configurado'} com sucesso:`,
              webhookData.id,
            );
          }
        } catch (error) {
          console.error(`❌ Erro ao configurar webhook ${gateway}:`, error);
        }
      }
      break;

    case 'stripe':
      // Futura implementação para Stripe
      if (payloadData.secretKey) {
        // TODO: Implementar configuração de webhook Stripe
        console.log('Stripe webhook configuration not yet implemented');
      }
      break;

    case 'mercadoPago':
      // Futura implementação para Mercado Pago
      if (payloadData.accessToken) {
        // TODO: Implementar configuração de webhook Mercado Pago
        console.log('Mercado Pago webhook configuration not yet implemented');
      }
      break;

    // Adicionar outros gateways conforme necessário
    default:
      console.log(
        `Gateway ${gateway} não possui configuração de webhook implementada`,
      );
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

  // Processa o payload se existir
  if (dto.payload) {
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

    // Configuração específica por gateway
    await configureGatewayWebhook({
      gateway: currentRecord.gateway as gateways,
      payloadData,
      companyId: Number(logParams.companyId),
      dto,
      isUpdate: true,
      currentWebhookId: currentPayload.webhookId,
    });
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
