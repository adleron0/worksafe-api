import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { SellerAccountService } from 'src/payments/application/seller-account.service';

export const noCompany = false;
export const omitAttributes = ['password', 'sellerConfig']; // Omitir sellerConfig das respostas

// Campos a serem encriptados na resposta do GET
export const encryptFields: string[] = [];

/*
 * Função de search personalizada para verificação antes de criar
 * Crie com os parametros de busca pré-criaão
 */
export function validateCreate(request: Request, CreateDto: any) {
  const search = {
    companyId: Number(request.user?.companyId),
    email: CreateDto.email,
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
// Regra da refatoração: nenhum rules.ts fala com gateway. Antes, estes hooks
// faziam `new AsaasService(prisma, new ConfigService(), new CacheService())`
// à mão — fora do container do Nest, abrindo uma conexão Redis por chamada e
// ignorando a configuração do módulo.
//
// Como os rules são funções soltas e não injectables, o service chega por
// fábrica: o controller injeta o SellerAccountService e monta os hooks com
// ele. Nenhuma alteração no GenericController foi necessária, porque os hooks
// já são passados pelo controller filho.

type SellerHookDeps = { sellerAccounts: SellerAccountService };

function buildSellerIdentity(source: any, companyId: number) {
  return {
    id: source.id ?? 0,
    name: source.name,
    cpf: source.cpf,
    email: source.email,
    phone: source.phone,
    birthDate: source.birthDate,
    address: source.address,
    addressNumber: source.addressNumber,
    addressComplement: source.addressComplement,
    neighborhood: source.neighborhood,
    city: source.city,
    state: source.state,
    zipCode: source.zipCode,
    companyId,
    sellerConfig: source.sellerConfig,
  };
}

export function makeHooksCreate({ sellerAccounts }: SellerHookDeps) {
  async function hookPreCreate(params: {
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  }) {
    const { dto, logParams } = params;

    if (dto.isSeller !== true) return;

    const companyId = dto.companyId || logParams?.companyId;

    try {
      const { sellerConfig, environment } = await sellerAccounts.provision(
        buildSellerIdentity(dto, companyId),
        dto.sellerConfig,
      );

      dto.sellerConfig = sellerConfig;
      dto.sellerActivatedAt = new Date();
      dto.sellerStatus = 'ACTIVE';

      console.log(`Subconta de vendedor criada em ${environment}`);
    } catch (error) {
      // Sem subconta não há para onde repassar comissão: não deixa o usuário
      // ser gravado como vendedor pela metade.
      dto.isSeller = false;
      throw new Error(`Falha ao criar vendedor: ${error.message}`);
    }
  }

  async function hookPosCreate() {
    // Personalize aqui se necessário
  }

  return { hookPreCreate, hookPosCreate };
}

export function makeHooksUpdate({ sellerAccounts }: SellerHookDeps) {
  async function hookPreUpdate(params: {
    id: number;
    dto: any;
    entity: any;
    prisma: PrismaService;
    logParams: any;
  }) {
    const { id, dto, prisma, logParams } = params;

    if (dto.isSeller === false) {
      // Mantém o sellerConfig para histórico de repasses já feitos.
      console.log(`Desativando vendedor ${id} - walletId preservado`);
      return;
    }

    if (dto.isSeller !== true) return;

    const currentUser = await prisma.selectOne('user', { where: { id } });
    const companyId =
      currentUser?.companyId || dto.companyId || logParams?.companyId;

    const alreadyProvisioned =
      await sellerAccounts.hasAccountForCurrentEnvironment(
        companyId,
        currentUser?.sellerConfig,
      );

    if (currentUser?.isSeller && alreadyProvisioned) return;
    if (alreadyProvisioned) return;

    try {
      const { sellerConfig, environment } = await sellerAccounts.provision(
        buildSellerIdentity({ ...currentUser, ...dto, id }, companyId),
        currentUser?.sellerConfig,
      );

      dto.sellerConfig = sellerConfig;
      if (!currentUser?.sellerActivatedAt) dto.sellerActivatedAt = new Date();
      dto.sellerStatus = 'ACTIVE';

      console.log(`Subconta do vendedor ${id} criada em ${environment}`);
    } catch (error) {
      dto.isSeller = false;
      throw new Error(`Falha ao ativar vendedor: ${error.message}`);
    }
  }

  async function hookPosUpdate() {
    // Personalize aqui se necessário
  }

  return { hookPreUpdate, hookPosUpdate };
}
