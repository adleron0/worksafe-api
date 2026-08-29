import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { gateways } from '@prisma/client';
import { GatewayCredentialsService } from 'src/payments/application/gateway-credentials.service';

export const noCompany = false;
export const omitAttributes: string[] = [];

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

/*
 * Função de search personalizada para verificação antes de criar
 */
export function getSearchParams(request: Request, CreateDto: any) {
  const search = {
    companyId: Number(request.user?.companyId),
    gateway: CreateDto.gateway,
  };

  return search;
}

/*
 * Função para formatar campos pré-update
 */
export function formaterPreUpdate(UpdateDto: any) {
  return UpdateDto;
}

// HOOKS DE PRÉ E PÓS CREATE/UPDATE
//
// As três variáveis globais mutáveis que existiam aqui
// (asaasServiceInstance / cacheServiceInstance / gatewayFactoryInstance,
// alimentadas por setters chamados no constructor do controller) foram
// removidas: eram um service locator, e obrigavam cada gateway novo a ganhar
// um `case` dentro das regras da entidade.
//
// Agora o controller injeta o GatewayCredentialsService e monta os hooks com
// ele — o mesmo padrão adotado em users/user/rules.ts.

type CredentialsHookDeps = { credentials: GatewayCredentialsService };

export function makeHooksCreate({ credentials }: CredentialsHookDeps) {
  async function hookPreCreate(params: {
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  }) {
    const { dto, logParams } = params;
    if (!dto.payload) return;

    const payload = credentials.parsePayload(dto.payload);

    dto.payload = await credentials.configure({
      gateway: dto.gateway as gateways,
      payload,
      companyId: Number(logParams.companyId),
    });
  }

  async function hookPosCreate() {
    // Personalize aqui se necessário
  }

  return { hookPreCreate, hookPosCreate };
}

export function makeHooksUpdate({ credentials }: CredentialsHookDeps) {
  async function hookPreUpdate(params: {
    id: number;
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  }) {
    const { id, dto, prisma, logParams } = params;

    const currentRecord = await prisma.selectFirst('companyGateWays', {
      where: { id: Number(id) },
    });

    if (!currentRecord) {
      throw new BadRequestException('Gateway não encontrada');
    }

    if (dto.payload) {
      const payload = credentials.parsePayload(dto.payload);
      const currentPayload = credentials.parsePayload(currentRecord.payload);

      dto.payload = await credentials.configure({
        // O gateway do registro salvo manda: trocar de fornecedor é criar
        // outro registro, não editar este.
        gateway: currentRecord.gateway as gateways,
        payload,
        companyId: Number(logParams.companyId),
        currentWebhookId: currentPayload?.webhookId,
      });
    }

    if (dto.active === false && currentRecord.active === true) {
      dto.inactiveAt = new Date();
    }

    if (dto.active === true && currentRecord.active === false) {
      dto.inactiveAt = null;
    }
  }

  async function hookPosUpdate() {
    // Personalize aqui se necessário
  }

  return { hookPreUpdate, hookPosUpdate };
}
