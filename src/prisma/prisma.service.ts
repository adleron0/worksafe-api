import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getChanges } from 'src/utils/getChanges';
import { entityScopeExtension } from 'src/features/company-entity/entity-scope';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private methods = {
    findUnique: 'findUnique',
    findFirst: 'findFirst',
    findMany: 'findMany',
    create: 'create',
    createMany: 'createMany',
    update: 'update',
    delete: 'delete',
    count: 'count',
  } as const;

  constructor() {
    super({
      // Configura logs condicionalmente
      log:
        process.env.LOGS_DB === 'true'
          ? [
              { emit: 'stdout', level: 'query' }, // Queries SQL
              { emit: 'stdout', level: 'info' }, // Informações gerais
              { emit: 'stdout', level: 'warn' }, // Avisos
              { emit: 'stdout', level: 'error' }, // Erros
            ]
          : [],
    });
    // usuário limitado a alguns CNPJs: a trava fica no próprio cliente (ver entity-scope.ts)
    return this.$extends(entityScopeExtension) as unknown as this;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // COREBASE PRISMA

  /**
   * selectOne: Retorna um objeto com os dados do banco
   * @param model Model do prisma
   * @param params Parametros para a consulta
   * @returns Objeto com os dados do banco
   */
  async selectOne<Model extends keyof PrismaClient>(model: Model, params: any) {
    return this[model][this.methods.findUnique]({
      ...params,
    });
  }

  /**
   * selectFirst: Retorna o primeiro objeto com os dados do banco
   * @param model Model do prisma
   * @param params Parametros para a consulta
   * @returns Objeto com os dados do banco
   */
  async selectFirst<Model extends keyof PrismaClient>(
    model: Model,
    params: any,
  ) {
    return this[model][this.methods.findFirst]({
      ...params,
    });
  }

  /**
   * select: Retorna um array com os dados do banco
   * @param model Model do prisma
   * @param params Parametros para a consulta
   * @param orderBy Ordenação dos itens
   * @returns Array com os dados do banco
   */
  async select<Model extends keyof PrismaClient>(
    model: Model,
    params: any,
    orderBy = [{ id: 'desc' }],
  ) {
    const result = await this[model][this.methods.findMany]({
      orderBy,
      ...params,
    });
    return result;
  }

  /**
   * selectPaging: Retorna um array e total com os dados do banco
   * @param model Model do prisma
   * @param params Parametros para a consulta
   * @param skip Número de itens a serem pulados
   * @param limit Número de itens a serem retornados
   * @param orderBy Ordenação dos itens
   * @returns Objeto com os dados do banco e o total de itens
   */
  async selectPaging<Model extends keyof PrismaClient>(
    model: Model,
    params: any,
    skip = 0,
    limit = 10,
    orderBy: object,
  ) {
    const { where } = params;

    const [rows, total] = await Promise.all([
      this[model][this.methods.findMany]({
        orderBy,
        skip,
        take: limit,
        ...params,
      }),
      this[model][this.methods.count]({ where }),
    ]);
    return {
      total,
      rows,
    };
  }

  /**
   * makeTransactions: Executa transações em paralelo
   * @param transactions Array de transações
   * @returns Retorna o resultado da transação
   */
  makeTransactions(transactions: any[]) {
    return this.$transaction(async (tx) => {
      for (const transaction of transactions) {
        await transaction(tx);
      }
    });
  }

  /**
   * insert: Insere um novo registro no banco
   * @param model Model do prisma
   * @param data Dados do registro
   * @param logParams Parametros para o log (opcional)
   * @param tx Transação
   * @returns Retorna o resultado da inserção
   */
  async insert<Model extends keyof PrismaClient>(
    model: Model,
    data: any,
    logParams?: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    try {
      const result = await use[model][this.methods.create]({
        data,
      });
      if (result && logParams) {
        use.system_Logs
          .create({
            data: {
              companyId: logParams.companyId,
              userId: logParams.userId || 0,
              action: 'create',
              entity: String(model),
              entityId: result.id,
              column: null,
              oldValue: null,
              newValue: JSON.stringify(data),
            },
          })
          .catch(() => {
            // Ignora silenciosamente erros de auditoria
            console.log('⚠️  Log de auditoria não registrado');
          });
      }
      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * bulkInsert: Insere vários registros no banco
   * @param model Model do prisma
   * @param data Dados dos registros
   * @param tx Transação
   * @returns Retorna o resultado da inserção
   */
  async bulkInsert<Model extends keyof PrismaClient>(
    model: Model,
    data: any[],
    // logParams: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    try {
      const result = await use[model][this.methods.createMany]({
        data,
        skipDuplicates: true,
      });
      // createMany não retorna o resultado da inserção, então ainda não sei como fazer os logs dele [evitar usar]
      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * bulkUpdate: Atualiza múltiplos registros no banco
   * @param model Model do prisma
   * @param data Dados para atualizar
   * @param where Condições para filtrar os registros
   * @param logParams Parametros para o log (opcional)
   * @param tx Transação
   * @returns Retorna o número de registros atualizados
   */
  async bulkUpdate<Model extends keyof PrismaClient>(
    model: Model,
    data: any,
    where: any,
    logParams?: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    try {
      // Usa o updateMany nativo do Prisma
      const result = await use[model].updateMany({
        where,
        data,
      });

      // Log simplificado para operações em massa
      if (result && result.count > 0 && logParams) {
        use.system_Logs
          .create({
            data: {
              companyId: logParams.companyId,
              userId: logParams.userId || 0, // Usa 0 como padrão se não tiver usuário
              action: 'bulk_update',
              entity: String(model),
              entityId: 0, // Não tem ID específico em bulk
              column: 'bulk',
              oldValue: JSON.stringify({ count: result.count }),
              newValue: JSON.stringify(data),
            },
          })
          .catch(() => {
            // Ignora silenciosamente erros de auditoria
            console.log('⚠️  Log de auditoria não registrado');
          });
      }

      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * update: Atualiza um registro no banco
   * @param model Model do prisma
   * @param data Dados do registro
   * @param logParams Parametros para o log (opcional)
   * @param params Parametros para a consulta
   * @param id ID do registro a ser atualizado
   * @param tx Transação
   * @returns Retorna o resultado da atualização
   */
  async update<Model extends keyof PrismaClient>(
    model: Model,
    data: any,
    logParams?: any,
    params?: any,
    id?: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    if (id) {
      params = params || {};
      params.where = params.where || {};
      params.where.id = Number(id);
    }
    try {
      const oldValues = await use[model][this.methods.findUnique]({
        ...params,
      });
      const result = await use[model][this.methods.update]({
        ...params,
        data,
      });

      const changes = getChanges(oldValues, result);

      if (result && changes.length > 0 && logParams) {
        use.system_Logs
          .createMany({
            data: changes.map((change) => ({
              companyId: logParams.companyId,
              userId: logParams.userId || 0,
              action: 'update',
              entity: String(model),
              entityId: Number(result.id),
              column: change.column,
              oldValue: JSON.stringify(change.oldValue),
              newValue: JSON.stringify(change.newValue),
            })),
          })
          .catch(() => {
            // Ignora silenciosamente erros de auditoria
            console.log('⚠️  Log de auditoria não registrado');
          });
      }
      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * selectOrCreate: Busca um registro ou cria se não existir
   * @param model Model do prisma
   * @param where Condições para buscar o registro
   * @param data Dados para criar o registro se não existir
   * @param logParams Parametros para o log (opcional)
   * @param tx Transação
   * @returns Retorna o registro encontrado ou criado
   */
  async selectOrCreate<Model extends keyof PrismaClient>(
    model: Model,
    where: any,
    data: any,
    logParams?: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    try {
      // Primeiro tenta encontrar o registro
      const existing = await use[model][this.methods.findFirst]({
        where,
      });

      // Se encontrou, retorna o existente
      if (existing) {
        return {
          data: existing,
          created: false,
        };
      }

      // Se não encontrou, cria um novo
      const result = await use[model][this.methods.create]({
        data,
      });

      // Log da criação
      if (result && logParams) {
        use.system_Logs
          .create({
            data: {
              companyId: logParams.companyId,
              userId: logParams.userId || 0,
              action: 'create',
              entity: String(model),
              entityId: result.id,
              column: null,
              oldValue: null,
              newValue: JSON.stringify(data),
            },
          })
          .catch(() => {
            // Ignora silenciosamente erros de auditoria
            console.log('⚠️  Log de auditoria não registrado');
          });
      }

      return {
        data: result,
        created: true,
      };
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * upsert: Insere ou atualiza um registro no banco
   * @param model Model do prisma
   * @param data Dados do registro
   * @param params Parametros para a consulta
   * @param logParams Parametros para o log (opcional)
   * @param tx Transação
   * @returns Retorna o resultado da inserção
   */
  async upsert<Model extends keyof PrismaClient>(
    model: Model,
    data: any,
    params: any,
    logParams?: any,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    try {
      const verifyExist = await use[model][this.methods.findFirst]({
        ...params,
      });

      let result;
      if (verifyExist) {
        result = await use[model][this.methods.update]({
          where: { id: verifyExist.id },
          data,
        });

        const changes = getChanges(verifyExist, result);

        if (result && changes.length > 0 && logParams) {
          use.system_Logs
            .createMany({
              data: changes.map((change) => ({
                companyId: logParams.companyId,
                userId: logParams.userId || 0,
                action: 'update',
                entity: String(model),
                entityId: Number(result.id),
                column: change.column,
                oldValue: JSON.stringify(change.oldValue),
                newValue: JSON.stringify(change.newValue),
              })),
            })
            .catch(() => {
              // Ignora silenciosamente erros de auditoria
              console.log('⚠️  Log de auditoria não registrado');
            });
        }
      } else {
        result = await use[model][this.methods.create]({
          data,
        });

        if (result && logParams) {
          use.system_Logs
            .create({
              data: {
                companyId: logParams.companyId,
                userId: logParams.userId || 0,
                action: 'create',
                entity: String(model),
                entityId: result.id,
                column: null,
                oldValue: null,
                newValue: JSON.stringify(data),
              },
            })
            .catch(() => {
              // Ignora silenciosamente erros de auditoria
              console.log('⚠️  Log de auditoria não registrado');
            });
        }
      }
      return result;
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  /**
   * erase: Faz um Soft_Delete ou Hard_Delete de um registro no banco
   * @param model Model do prisma
   * @param params Parametros para a consulta
   * @param logParams Parametros para o log (opcional)
   * @param virtual Virtual flag para soft_delete ou hard_delete
   * @param tx Transaction
   */
  async erase<Model extends keyof PrismaClient>(
    model: Model,
    params: any,
    logParams?: any,
    virtual?: boolean,
    tx?: any,
  ) {
    const use = tx ? tx : this;
    const soft = virtual !== undefined ? virtual : true;
    try {
      const oldValues = await use[model][this.methods.findUnique]({
        ...params,
      });

      let result;
      if (soft) {
        const formDeteleteData = {};
        if (Object.keys(oldValues).includes('inactiveAt'))
          formDeteleteData['inactiveAt'] = new Date();
        if (Object.keys(oldValues).includes('deletedAt'))
          formDeteleteData['deletedAt'] = new Date();
        if (Object.keys(oldValues).includes('active'))
          formDeteleteData['active'] = false;
        if (Object.keys(oldValues).includes('status'))
          formDeteleteData['status'] = false;

        result = await use[model][this.methods.update]({
          ...params,
          data: { ...formDeteleteData },
        });
        if (result && logParams) {
          use.system_Logs
            .create({
              data: {
                companyId: logParams.companyId,
                userId: logParams.userId || 0,
                action: 'soft_delete',
                entity: String(model),
                entityId: result.id,
                column: 'inactiveAt',
                oldValue: null,
                newValue: JSON.stringify(result.inactiveAt),
              },
            })
            .catch(() => {
              // Ignora silenciosamente erros de auditoria
              console.log('⚠️  Log de auditoria não registrado');
            });
        }
      } else {
        result = await use[model][this.methods.delete]({
          ...params,
        });
        if (result && logParams) {
          use.system_Logs
            .create({
              data: {
                companyId: logParams.companyId,
                userId: logParams.userId || 0,
                action: 'delete',
                entity: String(model),
                entityId: oldValues.id,
                column: null,
                oldValue: JSON.stringify(oldValues),
                newValue: null,
              },
            })
            .catch(() => {
              // Ignora silenciosamente erros de auditoria
              console.log('⚠️  Log de auditoria não registrado');
            });
        }
      }
      return result;
    } catch (error) {
      console.log('🚀 ~ error:', error);
      throw new BadRequestException(error);
    }
  }
}
