import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { ConfigService } from '@nestjs/config';
import { CacheService } from 'src/common/cache/cache.service';

export const noCompany = false;
export const omitAttributes = ['password', 'sellerConfig']; // Omitir sellerConfig das respostas

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
    email: CreateDto.email,
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
  const { dto, prisma } = params;

  // Se está criando como seller
  if (dto.isSeller === true) {
    console.log('Criando usuário como seller...');

    // Validar dados obrigatórios para subconta
    const errors = [];

    if (!dto.email) errors.push('Email é obrigatório');
    if (!dto.cpf) errors.push('CPF é obrigatório');
    if (!dto.phone) errors.push('Telefone é obrigatório');
    if (!dto.name) errors.push('Nome é obrigatório');

    // Validar endereço (recomendado mas não obrigatório)
    if (
      !dto.zipCode ||
      !dto.address ||
      !dto.neighborhood ||
      !dto.city ||
      !dto.state
    ) {
      console.warn(
        'Endereço incompleto - subconta será criada com dados mínimos',
      );
    }

    if (errors.length > 0) {
      throw new Error(
        `Dados insuficientes para criar seller: ${errors.join(', ')}`,
      );
    }

    try {
      // Instanciar AsaasService
      const configService = new ConfigService();
      const cacheService = new CacheService();
      const asaasService = new AsaasService(
        prisma,
        configService,
        cacheService,
      );

      // Preparar dados do usuário
      const userData = {
        id: 0, // Será preenchido após criar
        name: dto.name,
        cpf: dto.cpf,
        email: dto.email,
        phone: dto.phone,
        birthDate: dto.birthDate,
        address: dto.address,
        addressNumber: dto.addressNumber,
        addressComplement: dto.addressComplement,
        neighborhood: dto.neighborhood,
        city: dto.city,
        state: dto.state,
        zipCode: dto.zipCode,
        companyId: dto.companyId || params.logParams?.companyId || 1,
        sellerConfig: dto.sellerConfig,
      };

      // Criar subconta no Asaas
      const asaasResult = await asaasService.getOrCreateSubAccount(userData);

      // Preparar sellerConfig com estrutura separada por ambiente
      dto.sellerConfig = {
        ...dto.sellerConfig,
        gateways: {
          ...dto.sellerConfig?.gateways,
          asaas: {
            ...dto.sellerConfig?.gateways?.asaas,
            [asaasResult.environment]: asaasResult.config,
          },
        },
        createdAt: new Date().toISOString(),
      };

      dto.sellerActivatedAt = new Date();
      dto.sellerStatus = 'ACTIVE';

      console.log(
        `Subconta criada em ${asaasResult.environment}:`,
        asaasResult.config.walletId,
      );
    } catch (error) {
      console.error('Erro ao criar subconta:', error);
      // Reverter isSeller se falhar
      dto.isSeller = false;
      throw new Error(`Falha ao criar subconta Asaas: ${error.message}`);
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
  _created: any,
) {
  // const { dto, entity } = params;
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
  const { id, dto, prisma } = params;

  // Se está ativando como seller
  if (dto.isSeller === true) {
    // Buscar usuário atual - FORMA CORRETA com PrismaService
    const currentUser = await prisma.selectOne('user', {
      where: { id },
    });

    // Instanciar services
    const configService = new ConfigService();
    const cacheService = new CacheService();

    // Determinar ambiente
    const isSandbox = configService.get('BASE_SETUP') === 'development';
    const environment = isSandbox ? 'sandbox' : 'production';

    // Verificar se já tem walletId para o ambiente atual
    const hasWalletForEnvironment =
      currentUser?.sellerConfig?.gateways?.asaas?.[environment]?.walletId;

    if (currentUser?.isSeller && hasWalletForEnvironment) {
      console.log(`User ${id} já possui subconta para ${environment}`);
      return;
    }

    // Se não tem walletId para o ambiente atual, criar subconta
    if (!hasWalletForEnvironment) {
      console.log(`Ativando user ${id} como seller para ${environment}...`);

      // Mesclar dados atuais com novos
      const userData = {
        ...currentUser,
        ...dto,
        id,
        companyId:
          currentUser?.companyId ||
          dto.companyId ||
          params.logParams?.companyId ||
          1,
      };

      // Validar dados obrigatórios
      const errors = [];
      if (!userData.email) errors.push('Email é obrigatório');
      if (!userData.cpf) errors.push('CPF é obrigatório');
      if (!userData.phone) errors.push('Telefone é obrigatório');
      if (!userData.name) errors.push('Nome é obrigatório');

      // Validar endereço (recomendado mas não obrigatório)
      if (
        !userData.zipCode ||
        !userData.address ||
        !userData.neighborhood ||
        !userData.city ||
        !userData.state
      ) {
        console.warn(
          'Endereço incompleto - subconta será criada com dados mínimos',
        );
      }

      if (errors.length > 0) {
        throw new Error(
          `Dados insuficientes para ativar seller: ${errors.join(', ')}`,
        );
      }

      try {
        // Instanciar AsaasService
        const asaasService = new AsaasService(
          prisma,
          configService,
          cacheService,
        );

        // Criar subconta no Asaas
        const asaasResult = await asaasService.getOrCreateSubAccount(userData);

        // Atualizar sellerConfig com estrutura separada por ambiente
        dto.sellerConfig = {
          ...currentUser?.sellerConfig,
          ...dto.sellerConfig,
          gateways: {
            ...currentUser?.sellerConfig?.gateways,
            ...dto.sellerConfig?.gateways,
            asaas: {
              ...currentUser?.sellerConfig?.gateways?.asaas,
              ...dto.sellerConfig?.gateways?.asaas,
              [asaasResult.environment]: asaasResult.config,
            },
          },
          updatedAt: new Date().toISOString(),
        };

        if (!currentUser?.sellerActivatedAt) {
          dto.sellerActivatedAt = new Date();
        }

        dto.sellerStatus = 'ACTIVE';

        console.log(
          `Subconta criada para user ${id} em ${asaasResult.environment}:`,
          asaasResult.config.walletId,
        );
      } catch (error) {
        console.error('Erro ao criar subconta:', error);
        // Reverter isSeller se falhar
        dto.isSeller = false;
        throw new Error(`Falha ao ativar seller: ${error.message}`);
      }
    }
  }

  // Se está desativando seller
  if (dto.isSeller === false) {
    console.log(`Desativando seller ${id} - mantendo walletId para histórico`);
    // Não remove sellerConfig, apenas marca como false
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
  _updated: any,
) {
  // const { id, dto, entity } = params;
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
