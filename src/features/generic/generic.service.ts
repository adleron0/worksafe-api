import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
// utils specific imports
import { hash } from 'bcrypt';
import { ifNumberParseNumber } from 'src/utils/ifNumberParseNumber';
import { ifBooleanParseBoolean } from 'src/utils/isBooleanParseBoolean';
import {
  encryptionConfig,
  applyEncryption,
  applyDynamicEncryption,
} from './encryption.config';

type logParams = {
  userId: string;
  companyId: string;
};

type entity = {
  model: keyof PrismaClient;
  name: string;
  route: string;
  permission: string;
};

// Função utilitária para processar filtros
function parseFilterObject(filterObj: any, skipNestedFilters = false) {
  const condition: any = {};
  for (const key in filterObj) {
    // Pula filtros de associações aninhadas se solicitado
    if (skipNestedFilters && key.includes('.')) {
      continue;
    }

    if (key.includes('in-')) {
      const fieldPath = key.substring(3); // Remove 'in-' prefix
      // Pula se for filtro de associação aninhada
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      const array = filterObj[key]
        .split(',')
        .map((item: any) => ifNumberParseNumber(item));

      if (!fieldPath.includes('.')) {
        condition[fieldPath] = { in: array };
      }
    } else if (key.includes('notin-')) {
      const fieldPath = key.substring(6); // Remove 'notin-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      const array = filterObj[key]
        .split(',')
        .map((item: any) => ifNumberParseNumber(item));

      if (!fieldPath.includes('.')) {
        condition[fieldPath] = { notIn: array };
      }
    } else if (key.includes('like-')) {
      const fieldPath = key.substring(5); // Remove 'like-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        condition[fieldPath] = {
          contains: filterObj[key],
          mode: 'insensitive',
        };
      }
    } else if (key.includes('notlike-')) {
      const fieldPath = key.substring(8); // Remove 'notlike-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        condition[fieldPath] = {
          not: {
            contains: filterObj[key],
            mode: 'insensitive',
          },
        };
      }
    } else if (key.includes('not-')) {
      const fieldPath = key.substring(4); // Remove 'not-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        condition[fieldPath] = {
          not: ifNumberParseNumber(filterObj[key]),
        };
      }
    } else if (key.includes('gt-')) {
      const fieldPath = key.substring(3); // Remove 'gt-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        if (!condition[fieldPath]) condition[fieldPath] = {};
        condition[fieldPath].gt = ifNumberParseNumber(filterObj[key]);
      }
    } else if (key.includes('lt-')) {
      const fieldPath = key.substring(3); // Remove 'lt-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        if (!condition[fieldPath]) condition[fieldPath] = {};
        condition[fieldPath].lt = ifNumberParseNumber(filterObj[key]);
      }
    } else if (key.includes('gte-')) {
      const fieldPath = key.substring(4); // Remove 'gte-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        if (!condition[fieldPath]) condition[fieldPath] = {};
        condition[fieldPath].gte = ifNumberParseNumber(filterObj[key]);
      }
    } else if (key.includes('lte-')) {
      const fieldPath = key.substring(4); // Remove 'lte-' prefix
      if (skipNestedFilters && fieldPath.includes('.')) continue;

      if (!fieldPath.includes('.')) {
        if (!condition[fieldPath]) condition[fieldPath] = {};
        condition[fieldPath].lte = ifNumberParseNumber(filterObj[key]);
      }
    } else {
      // Para campos sem operador
      if (!skipNestedFilters || !key.includes('.')) {
        condition[key] = ifNumberParseNumber(filterObj[key]);
        condition[key] = ifBooleanParseBoolean(condition[key]);
      }
    }
  }
  return condition;
}

// Nova função para processar filtros de associações aninhadas
function processNestedFilters(
  filters: any,
  includesToShow: string[],
  paramsIncludes: any,
) {
  const nestedFilters: any = {
    belongsToFilters: {}, // Para relações Many-to-One (aplicar no where principal)
    hasManyFilters: {}, // Para relações One-to-Many (aplicar no include com where)
  };

  // Identifica todos os filtros que contêm pontos (indicando associações aninhadas)
  for (const key in filters) {
    // Processa diferentes operadores
    let operator = '';
    let fieldPath = key;

    if (key.startsWith('like-')) {
      operator = 'like-';
      fieldPath = key.substring(5);
    } else if (key.startsWith('notlike-')) {
      operator = 'notlike-';
      fieldPath = key.substring(8);
    } else if (key.startsWith('in-')) {
      operator = 'in-';
      fieldPath = key.substring(3);
    } else if (key.startsWith('notin-')) {
      operator = 'notin-';
      fieldPath = key.substring(6);
    } else if (key.startsWith('not-')) {
      operator = 'not-';
      fieldPath = key.substring(4);
    } else if (key.startsWith('gt-')) {
      operator = 'gt-';
      fieldPath = key.substring(3);
    } else if (key.startsWith('lt-')) {
      operator = 'lt-';
      fieldPath = key.substring(3);
    } else if (key.startsWith('gte-')) {
      operator = 'gte-';
      fieldPath = key.substring(4);
    } else if (key.startsWith('lte-')) {
      operator = 'lte-';
      fieldPath = key.substring(4);
    }

    // Verifica se é um filtro de associação aninhada
    if (fieldPath.includes('.')) {
      const pathParts = fieldPath.split('.');
      const associationName = pathParts[0];

      // Verifica se a associação está incluída no 'show'
      if (includesToShow.includes(associationName)) {
        // Para relações Many-to-One (belongsTo), aplicamos o filtro no where principal
        // Vamos assumir que se tem select ou é um objeto simples, é Many-to-One
        const isBelongsTo =
          paramsIncludes[associationName] &&
          (paramsIncludes[associationName].select ||
            typeof paramsIncludes[associationName] === 'boolean');

        if (isBelongsTo) {
          // Adiciona ao belongsToFilters para aplicar no where principal
          const fullPath = fieldPath; // Mantém o caminho completo
          const filterKey = operator ? `${operator}${fullPath}` : fullPath;
          nestedFilters.belongsToFilters[filterKey] = filters[key];
        } else {
          // Para relações One-to-Many, mantém o comportamento original
          if (!nestedFilters.hasManyFilters[associationName]) {
            nestedFilters.hasManyFilters[associationName] = {};
          }

          const remainingPath = pathParts.slice(1).join('.');
          const filterKey = operator
            ? `${operator}${remainingPath}`
            : remainingPath;
          nestedFilters.hasManyFilters[associationName][filterKey] =
            filters[key];
        }
      }
    }
  }

  return nestedFilters;
}

// Função recursiva para aplicar filtros em includes aninhados
function applyFiltersToIncludes(
  include: any,
  nestedFilters: any,
  paramsIncludes: any,
) {
  const processedInclude: any = {};

  for (const [associationName, includeValue] of Object.entries(include)) {
    // Se há filtros para esta associação
    if (nestedFilters[associationName]) {
      const associationFilters = nestedFilters[associationName];

      // Separa filtros diretos de filtros aninhados
      const directFilters: any = {};
      const deeperNestedFilters: any = {};

      for (const [filterKey, filterValue] of Object.entries(
        associationFilters,
      )) {
        // Extrai o operador e o campo
        let operator = '';
        let fieldPath = filterKey;

        if (filterKey.startsWith('like-')) {
          operator = 'like-';
          fieldPath = filterKey.substring(5);
        } else if (filterKey.startsWith('notlike-')) {
          operator = 'notlike-';
          fieldPath = filterKey.substring(8);
        } else if (filterKey.startsWith('in-')) {
          operator = 'in-';
          fieldPath = filterKey.substring(3);
        } else if (filterKey.startsWith('notin-')) {
          operator = 'notin-';
          fieldPath = filterKey.substring(6);
        } else if (filterKey.startsWith('not-')) {
          operator = 'not-';
          fieldPath = filterKey.substring(4);
        } else if (filterKey.startsWith('gt-')) {
          operator = 'gt-';
          fieldPath = filterKey.substring(3);
        } else if (filterKey.startsWith('lt-')) {
          operator = 'lt-';
          fieldPath = filterKey.substring(3);
        } else if (filterKey.startsWith('gte-')) {
          operator = 'gte-';
          fieldPath = filterKey.substring(4);
        } else if (filterKey.startsWith('lte-')) {
          operator = 'lte-';
          fieldPath = filterKey.substring(4);
        }

        if (fieldPath.includes('.')) {
          // É um filtro aninhado mais profundo
          const [nestedAssoc, ...rest] = fieldPath.split('.');
          if (!deeperNestedFilters[nestedAssoc]) {
            deeperNestedFilters[nestedAssoc] = {};
          }
          const deepFilterKey = operator
            ? `${operator}${rest.join('.')}`
            : rest.join('.');
          deeperNestedFilters[nestedAssoc][deepFilterKey] = filterValue;
        } else {
          // É um filtro direto para esta associação
          directFilters[filterKey] = filterValue;
        }
      }

      // Constrói o objeto include para esta associação
      let associationInclude: any = {};

      // Adiciona filtros diretos
      if (Object.keys(directFilters).length > 0) {
        associationInclude.where = parseFilterObject(directFilters);
      }

      // Se há configuração específica em paramsIncludes
      if (
        paramsIncludes[associationName] &&
        typeof paramsIncludes[associationName] === 'object'
      ) {
        // Mescla com configurações existentes
        associationInclude = { ...paramsIncludes[associationName] };

        // Adiciona ou mescla os filtros where (só se não tiver select ou se é uma relação hasMany)
        if (
          Object.keys(directFilters).length > 0 &&
          !associationInclude.select
        ) {
          associationInclude.where = {
            ...(associationInclude.where || {}),
            ...parseFilterObject(directFilters),
          };
        }

        // Se há includes aninhados e filtros mais profundos
        if (
          associationInclude.include &&
          Object.keys(deeperNestedFilters).length > 0
        ) {
          associationInclude.include = applyFiltersToIncludes(
            associationInclude.include,
            deeperNestedFilters,
            paramsIncludes[associationName].include || {},
          );
        }
      } else if (
        Object.keys(directFilters).length > 0 ||
        Object.keys(deeperNestedFilters).length > 0
      ) {
        // Se há filtros mas não há configuração em paramsIncludes
        if (Object.keys(directFilters).length > 0) {
          associationInclude.where = parseFilterObject(directFilters);
        }

        if (Object.keys(deeperNestedFilters).length > 0) {
          // Precisa criar includes aninhados
          associationInclude.include = {};
          for (const nestedAssoc of Object.keys(deeperNestedFilters)) {
            associationInclude.include[nestedAssoc] = true;
          }
          associationInclude.include = applyFiltersToIncludes(
            associationInclude.include,
            deeperNestedFilters,
            {},
          );
        }
      }

      processedInclude[associationName] =
        Object.keys(associationInclude).length > 0
          ? associationInclude
          : includeValue === true
            ? true
            : includeValue;
    } else {
      // Mantém o include original se não há filtros
      processedInclude[associationName] = includeValue;
    }
  }

  return processedInclude;
}

@Injectable()
export class GenericService<TCreateDto, TUpdateDto, TEntity> {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {}

  // Helper para detectar se é arquivo único ou múltiplos
  private isMultipleFiles(
    file: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
  ): file is { [key: string]: Express.MulterS3.File[] } {
    // Se não tem file, retorna false
    if (!file) return false;

    // Verifica se é um objeto com arrays (múltiplos arquivos)
    // Múltiplos arquivos têm estrutura: { logo: [...], favicon: [...] }
    // Arquivo único tem propriedades como: fieldname, originalname, buffer (otimização) ou location (upload direto)
    return !(
      'fieldname' in file ||
      'originalname' in file ||
      'buffer' in file ||
      'location' in file
    );
  }

  async create(
    dto: TCreateDto,
    logParams: any,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    searchVerify = {},
    hooks?: {
      hookPreCreate?: (params: {
        dto: TCreateDto;
        entity: entity;
        prisma: PrismaService;
        logParams: any;
      }) => Promise<void> | void;
      hookPosCreate?: (
        params: {
          dto: TCreateDto;
          entity: entity;
          prisma: PrismaService;
          logParams: any;
        },
        created: TEntity,
      ) => Promise<void> | void;
    },
  ): Promise<TEntity> {
    try {
      if (hooks?.hookPreCreate) {
        await hooks.hookPreCreate({
          dto,
          entity,
          prisma: this.prisma,
          logParams,
        });
      }
      // Sempre ajuste a busca do verify do rules, ela é personalizada por entidade
      const verify = await this.prisma.selectFirst(entity.model, {
        where: {
          ...searchVerify,
        },
      });
      if (verify) {
        throw new BadRequestException(`${entity.name} já cadastrado`);
      }

      // Processa arquivos (unificado para arquivo único ou múltiplos)
      if (file) {
        if (this.isMultipleFiles(file)) {
          // Múltiplos arquivos
          for (const [fieldName, fileArray] of Object.entries(file)) {
            if (fileArray && fileArray[0]) {
              const urlFieldName = `${fieldName}Url`; // Ex: logo -> logoUrl
              dto[urlFieldName] = fileArray[0].location;
            }
          }
        } else {
          // Arquivo único - mantém compatibilidade com imageUrl
          dto['imageUrl'] = file.location;
        }
      }

      // Se `dto.password` existir, criptografa-a
      if (dto['password']) {
        const saltRounds = 10;
        const passwordHashed = await hash(dto['password'], saltRounds);
        dto['password'] = passwordHashed;
      }

      const created = await this.prisma.insert(
        entity.model,
        {
          ...dto,
        },
        logParams,
      );

      if (hooks?.hookPosCreate) {
        await hooks.hookPosCreate(
          { dto, entity, prisma: this.prisma, logParams },
          created,
        );
      }
      return created;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async get(
    filters: any,
    entity: entity,
    paramsIncludes = {},
    noCompany = false,
    encryptionFields: string[] | boolean = false, // Pode ser array de campos ou boolean
  ): Promise<{ total: number; rows: TEntity[] }> {
    try {
      const params: any = {};

      params.include = {};
      if (filters.includesToShow.length) {
        for (const association of filters.includesToShow) {
          if (paramsIncludes.hasOwnProperty(association)) {
            params.include[association] = paramsIncludes[association];
          } else {
            params.include[association] = true;
          }
        }
      }

      // Processa filtros de associações aninhadas
      const nestedFilters = processNestedFilters(
        filters,
        filters.includesToShow,
        paramsIncludes,
      );

      // Aplica filtros nas associações One-to-Many (hasManyFilters)
      if (
        Object.keys(nestedFilters.hasManyFilters).length > 0 &&
        Object.keys(params.include).length > 0
      ) {
        params.include = applyFiltersToIncludes(
          params.include,
          nestedFilters.hasManyFilters,
          paramsIncludes,
        );
      }

      // Excluindo atributos
      params.omit = {};

      if (filters.omitAttributes) {
        for (const attribute of filters.omitAttributes) {
          params.omit[attribute] = true;
        }
      }

      // Aplicando os filtros adicionais corretamente
      params.where = {};

      // Aplica filtros de relações Many-to-One (belongsToFilters) no where principal
      if (Object.keys(nestedFilters.belongsToFilters).length > 0) {
        for (const [filterKey, filterValue] of Object.entries(
          nestedFilters.belongsToFilters,
        )) {
          // Converte o filtro de associação para o formato do Prisma
          // Ex: like-trainee.name -> trainee: { name: { contains: ... } }
          let operator = '';
          let fieldPath = filterKey;

          if (filterKey.startsWith('like-')) {
            operator = 'like';
            fieldPath = filterKey.substring(5);
          } else if (filterKey.startsWith('notlike-')) {
            operator = 'notlike';
            fieldPath = filterKey.substring(8);
          } else if (filterKey.startsWith('in-')) {
            operator = 'in';
            fieldPath = filterKey.substring(3);
          } else if (filterKey.startsWith('notin-')) {
            operator = 'notin';
            fieldPath = filterKey.substring(6);
          } else if (filterKey.startsWith('not-')) {
            operator = 'not';
            fieldPath = filterKey.substring(4);
          } else if (filterKey.startsWith('gt-')) {
            operator = 'gt';
            fieldPath = filterKey.substring(3);
          } else if (filterKey.startsWith('lt-')) {
            operator = 'lt';
            fieldPath = filterKey.substring(3);
          } else if (filterKey.startsWith('gte-')) {
            operator = 'gte';
            fieldPath = filterKey.substring(4);
          } else if (filterKey.startsWith('lte-')) {
            operator = 'lte';
            fieldPath = filterKey.substring(4);
          }

          const pathParts = fieldPath.split('.');
          let currentLevel: any = params.where;

          // Navega pela estrutura aninhada
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (!currentLevel[pathParts[i]]) {
              currentLevel[pathParts[i]] = {};
            }
            currentLevel = currentLevel[pathParts[i]];
          }

          // Aplica o operador no campo final
          const finalField = pathParts[pathParts.length - 1];

          if (operator === 'like') {
            currentLevel[finalField] = {
              contains: filterValue,
              mode: 'insensitive',
            };
          } else if (operator === 'notlike') {
            currentLevel[finalField] = {
              not: { contains: filterValue, mode: 'insensitive' },
            };
          } else if (operator === 'in') {
            const array = (filterValue as string)
              .split(',')
              .map((item: any) => ifNumberParseNumber(item));
            currentLevel[finalField] = { in: array };
          } else if (operator === 'notin') {
            const array = (filterValue as string)
              .split(',')
              .map((item: any) => ifNumberParseNumber(item));
            currentLevel[finalField] = { notIn: array };
          } else if (operator === 'not') {
            currentLevel[finalField] = {
              not: ifNumberParseNumber(filterValue),
            };
          } else if (operator === 'gt') {
            currentLevel[finalField] = { gt: ifNumberParseNumber(filterValue) };
          } else if (operator === 'lt') {
            currentLevel[finalField] = { lt: ifNumberParseNumber(filterValue) };
          } else if (operator === 'gte') {
            currentLevel[finalField] = {
              gte: ifNumberParseNumber(filterValue),
            };
          } else if (operator === 'lte') {
            currentLevel[finalField] = {
              lte: ifNumberParseNumber(filterValue),
            };
          } else {
            currentLevel[finalField] = ifNumberParseNumber(filterValue);
          }
        }
      }

      // Suporte ao filtro OR
      if (filters.or && Array.isArray(filters.or)) {
        params.where.OR = filters.or.map(
          (orFilter: any) => parseFilterObject(orFilter, true), // skipNestedFilters = true para OR
        );
        // Remove o filtro 'or' do objeto principal para não duplicar condições
        delete filters.or;
      }

      // Filtros adicionais (pulando filtros de associações aninhadas)
      Object.assign(params.where, parseFilterObject(filters, true));

      // Deleta Específicos
      delete params.where.includesToShow;
      delete params.where.page;
      delete params.where.limit;
      delete params.where.active;
      delete params.where.orderBy;
      delete params.where.all;
      delete params.where.companyId;
      delete params.where.self;
      delete params.where.show;
      delete params.where.startedAt;
      delete params.where.endedAt;
      delete params.where.createdAt;
      delete params.where.omitAttributes;
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('order-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('in-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('notin-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('not-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('gte-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('lte-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('gt-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('lt-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('like-')) {
          delete params.where[key];
        }
      });
      Object.keys(params.where).forEach((key) => {
        if (key.startsWith('notlike-')) {
          delete params.where[key];
        }
      });

      // Remove filtros de associações aninhadas (que contêm pontos)
      Object.keys(params.where).forEach((key) => {
        if (key.includes('.')) {
          delete params.where[key];
        }
      });

      // Filtros específicos
      if (!noCompany) {
        params.where.companyId = filters.companyId;
      }

      if (filters.active === 'true') {
        // quero só os ativos → inactiveAt IS NULL
        params.where.inactiveAt = null;
      } else if (filters.active === 'false') {
        // quero só os inativos → inactiveAt IS NOT NULL
        params.where.inactiveAt = { not: null };
      }
      if (filters?.createdAt?.length === 1) {
        params.where.createdAt = new Date(filters.createdAt[0]);
      } else if (filters?.createdAt?.length === 2) {
        params.where.createdAt = {
          gte: new Date(filters.createdAt[0]),
          lte: new Date(filters.createdAt[1]),
        };
      }
      console.log('🚀 ~ GenericService ~ get ~ params:', params);

      // Definindo valores padrão para página e limite
      const page = filters.page ? Number(filters.page) + 1 : 1;
      const limit = filters.limit ? Number(filters.limit) : 10;

      // Calculando o número de itens a serem pulados (skip) com base na página atual
      const skip = (page - 1) * limit;

      // Ordenação
      let orderBy = [{ id: 'desc' }]; // Ordenação padrão
      if (filters.orderBy.length) orderBy = filters.orderBy; // Ordenação customizada da busca

      let result;
      if (filters.all) {
        result = await this.prisma.select(entity.model, params, orderBy);
      } else {
        result = await this.prisma.selectPaging(
          entity.model,
          params,
          skip,
          limit,
          orderBy,
        );
      }

      // Aplica encriptação se habilitada
      if (encryptionFields) {
        // Se for um array de campos específicos
        if (Array.isArray(encryptionFields)) {
          // Para resultado com paginação
          if (result.rows) {
            result.rows = applyDynamicEncryption(result.rows, encryptionFields);
          }
          // Para resultado sem paginação (quando filters.all = true)
          else if (Array.isArray(result)) {
            result = applyDynamicEncryption(result, encryptionFields);
          }
        }
        // Se for true, usa a configuração padrão
        else if (
          encryptionFields === true &&
          encryptionConfig[entity.model as string]
        ) {
          const config = encryptionConfig[entity.model as string];

          // Para resultado com paginação
          if (result.rows) {
            result.rows = applyEncryption(
              result.rows,
              config.fields || [],
              config.relations,
            );
          }
          // Para resultado sem paginação (quando filters.all = true)
          else if (Array.isArray(result)) {
            result = applyEncryption(
              result,
              config.fields || [],
              config.relations,
            );
          }
        }
      }

      // Retornando a lista de usuários e a contagem total
      return result;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async update(
    id: number,
    dto: TUpdateDto,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    hooks?: {
      hookPreUpdate?: (params: {
        id: number;
        dto: TUpdateDto;
        entity: entity;
        prisma: PrismaService;
        logParams: logParams;
      }) => Promise<void> | void;
      hookPosUpdate?: (
        params: {
          id: number;
          dto: TUpdateDto;
          entity: entity;
          prisma: PrismaService;
          logParams: logParams;
        },
        updated: TEntity,
      ) => Promise<void> | void;
    },
  ): Promise<TEntity> {
    try {
      if (hooks?.hookPreUpdate) {
        await hooks.hookPreUpdate({
          id,
          dto,
          entity,
          prisma: this.prisma,
          logParams,
        });
      }
      const verifyExist = await this.prisma.selectOne(entity.model, {
        where: {
          id: id,
        },
      });

      if (!verifyExist) {
        throw new NotFoundException(`${entity.name} não encontrado`);
      }

      // Processa arquivos (unificado para arquivo único ou múltiplos)
      if (file) {
        if (this.isMultipleFiles(file)) {
          // Múltiplos arquivos
          for (const [fieldName, fileArray] of Object.entries(file)) {
            if (fileArray && fileArray[0]) {
              const urlFieldName = `${fieldName}Url`; // Ex: logo -> logoUrl
              const existingUrl = verifyExist[urlFieldName];

              // Se há uma URL existente, deleta do S3
              if (existingUrl) {
                console.log(
                  `🚀 ~ GenericService ~ update ~ ${urlFieldName}:`,
                  existingUrl,
                );
                await this.uploadService.deleteImageFromS3(existingUrl);
              }

              // Define a nova URL
              dto[urlFieldName] = fileArray[0].location;
            }
          }

          // Processa campos de URL nulos para múltiplos arquivos
          for (const [fieldName] of Object.entries(file)) {
            const urlFieldName = `${fieldName}Url`;
            // Se o campo URL é null e não há novo arquivo, exclui a imagem existente
            if (
              dto[urlFieldName] === null &&
              !file[fieldName]?.[0] &&
              verifyExist[urlFieldName]
            ) {
              await this.uploadService.deleteImageFromS3(
                verifyExist[urlFieldName],
              );
              dto[urlFieldName] = null;
            }
          }
        } else {
          // Arquivo único - mantém compatibilidade com imageUrl
          if (verifyExist.imageUrl) {
            console.log(
              '🚀 ~ GenericService ~ update ~ verifyExist.imageUrl:',
              verifyExist.imageUrl,
            );
            await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
          }
          dto['imageUrl'] = file.location;
        }
      }

      // Se `dto.imageUrl` é null e não há nova imagem, exclui a imagem existente
      if (!dto['imageUrl'] && !file && verifyExist.imageUrl) {
        await this.uploadService.deleteImageFromS3(verifyExist.imageUrl);
        dto['imageUrl'] = null;
      }

      // Se houver uma nova senha, criptografa-a
      if (dto['password']) {
        const saltRounds = 10;
        const passwordHashed = await hash(dto['password'], saltRounds);
        dto['password'] = passwordHashed;
      }

      const updated = await this.prisma.update(
        entity.model,
        {
          ...dto,
        },
        logParams,
        {},
        id,
      );
      if (hooks?.hookPosUpdate) {
        await hooks.hookPosUpdate(
          { id, dto, entity, prisma: this.prisma, logParams },
          updated,
        );
      }
      return updated;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async changeStatus(
    id: number,
    type: string,
    logParams: logParams,
    entity: entity,
  ): Promise<TEntity> {
    const verifyExist = await this.prisma.selectOne(entity.model, {
      where: {
        id: id,
      },
    });
    if (!verifyExist) {
      throw new NotFoundException(`${entity.name} não encontrado`);
    }

    try {
      const data = {};
      data['updatedAt'] = new Date();

      if (verifyExist.hasOwnProperty('active')) data['active'] = true;
      if (verifyExist.hasOwnProperty('inactiveAt')) data['inactiveAt'] = null;
      if (verifyExist.hasOwnProperty('deletedAt')) data['deletedAt'] = null;
      if (verifyExist.hasOwnProperty('status')) data['status'] = true;

      if (type === 'inactive') {
        if (verifyExist.hasOwnProperty('active')) data['active'] = false;
        if (verifyExist.hasOwnProperty('inactiveAt'))
          data['inactiveAt'] = new Date();
        if (verifyExist.hasOwnProperty('deletedAt'))
          data['deletedAt'] = new Date();
        if (verifyExist.hasOwnProperty('status')) data['status'] = false;
      }

      const user = await this.prisma.update(entity.model, data, logParams, {
        where: {
          id: id,
        },
      });

      return user;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }

  async upsert(
    dto: TCreateDto | TUpdateDto,
    whereCondition: any,
    logParams: logParams,
    entity: entity,
    file?: Express.MulterS3.File | { [key: string]: Express.MulterS3.File[] },
    hooks?: {
      hookPreUpsert?: (params: {
        id: number;
        dto: TCreateDto | TUpdateDto;
        entity: entity;
        prisma: PrismaService;
        logParams: logParams;
      }) => Promise<void> | void;
      hookPosUpsert?: (
        params: {
          id: number;
          dto: TCreateDto | TUpdateDto;
          entity: entity;
          prisma: PrismaService;
          logParams: logParams;
        },
        upserted: TEntity,
      ) => Promise<void> | void;
    },
  ): Promise<TEntity> {
    try {
      // Busca o registro existente para obter o ID
      const existingRecord = await this.prisma.selectFirst(entity.model, {
        where: whereCondition,
      });

      const recordId = existingRecord?.id || 0;

      if (hooks?.hookPreUpsert) {
        await hooks.hookPreUpsert({
          id: recordId,
          dto,
          entity,
          prisma: this.prisma,
          logParams,
        });
      }

      // Processa arquivos (unificado para arquivo único ou múltiplos)
      if (file) {
        if (this.isMultipleFiles(file)) {
          // Múltiplos arquivos
          for (const [fieldName, fileArray] of Object.entries(file)) {
            if (fileArray && fileArray[0]) {
              const urlFieldName = `${fieldName}Url`; // Ex: logo -> logoUrl
              dto[urlFieldName] = fileArray[0].location;
            }
          }
        } else {
          // Arquivo único - mantém compatibilidade com imageUrl
          dto['imageUrl'] = file.location;
        }
      }

      // Se `dto.password` existir, criptografa-a
      if (dto['password']) {
        const saltRounds = 10;
        const passwordHashed = await hash(dto['password'], saltRounds);
        dto['password'] = passwordHashed;
      }

      const upserted = await this.prisma.upsert(
        entity.model,
        dto,
        {
          where: whereCondition,
        },
        logParams,
      );

      if (hooks?.hookPosUpsert) {
        await hooks.hookPosUpsert(
          { id: upserted.id, dto, entity, prisma: this.prisma, logParams },
          upserted,
        );
      }

      return upserted;
    } catch (error) {
      console.log('🚀 ~ GenericService<TCreateDto, ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
