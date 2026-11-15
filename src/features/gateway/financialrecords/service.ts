import { SellerWalletService } from 'src/features/commercial/wallet.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { financialRecordsStatus, paymentMethods } from '@prisma/client';
import { assertClassification } from 'src/features/financial/classification';
import { idList, settleExtras } from 'src/features/financial/payable.service';

export interface SettleInput {
  /** Data em que o dinheiro entrou (YYYY-MM-DD ou ISO). Padrão: agora. */
  paidAt?: string;
  /** Valor que de fato entrou. Padrão: valor líquido, senão o valor do título. */
  receivedValue?: number | string;
  paymentMethod?: string;
  observations?: string;
  /** Conta bancária/caixa em que o dinheiro entrou. */
  bankAccountId?: number | string | null;
  interestValue?: number | string | null;
  fineValue?: number | string | null;
  discountValue?: number | string | null;
}

export interface Actor {
  userId: number;
  companyId: number;
}

/** Em aberto = ainda pode receber baixa. */
const OPEN_STATUSES: financialRecordsStatus[] = [
  financialRecordsStatus.waiting,
  financialRecordsStatus.overdue,
  financialRecordsStatus.processing,
];

@Injectable()
export class FinancialrecordsService {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
    protected wallet: SellerWalletService,
  ) {
  }

  // Métodos removidos - usar PrismaService diretamente:
  // - createFinancialRecord: usar prisma.insert('financialRecords', ...)
  // - updateFinancialRecord: usar prisma.update('financialRecords', ...)
  // - getFinancialRecordById: usar prisma.selectOne('financialRecords', ...)
  // - getFinancialRecordSummary: usar prisma.selectOne('financialRecords', { select: {...} })

  /**
   * Busca um registro financeiro pela key (UUID)
   */
  async getFinancialRecordByKey(key: string): Promise<any> {
    console.log(
      '🚀 ~ FinancialrecordsService ~ getFinancialRecordByKey ~ key:',
      key,
    );
    try {
      const record = await this.prisma.selectFirst('financialRecords', {
        where: { key },
        select: {
          id: true,
          status: true,
          paymentMethod: true,
          value: true,
          dueDate: true,
          paidAt: true,
          billUrl: true,
          billNumber: true,
          pixUrl: true,
          pixNumber: true,
          externalId: true,
          key: true,
        },
      });

      if (!record) {
        throw new HttpException(
          'Registro financeiro não encontrado',
          HttpStatus.NOT_FOUND,
        );
      }

      return record;
    } catch (error) {
      console.log(
        '🚀 ~ FinancialrecordsService ~ getFinancialRecordByKey ~ error:',
        error,
      );
      if (error instanceof HttpException) throw error;
      throw new BadRequestException('Erro ao buscar registro financeiro');
    }
  }

  /**
   * Marca um registro financeiro como pago
   */
  async markAsPaid(id: number, externalData?: any): Promise<any> {
    const updateData: any = {
      status: financialRecordsStatus.received,
      paidAt: new Date(),
    };

    if (externalData) {
      updateData.responseData = externalData;
    }

    return await this.prisma.update(
      'financialRecords',
      updateData,
      {}, // logParams
      null,
      id,
    );
  }

  /**
   * Marca um registro financeiro como cancelado
   */
  async markAsCancelled(id: number, reason?: string): Promise<any> {
    const updateData: any = {
      status: financialRecordsStatus.cancelled,
      observations: reason,
    };

    return await this.prisma.update(
      'financialRecords',
      updateData,
      {}, // logParams
      null,
      id,
    );
  }

  private async findOwned(id: number, companyId: number) {
    const record = await this.prisma.financialRecords.findFirst({
      where: { id, companyId },
    });
    if (!record) throw new NotFoundException('Conta a receber não encontrada');
    return record;
  }

  /**
   * Baixa manual: o dinheiro entrou por fora do sistema (transferência, boleto
   * do banco, dinheiro) e alguém do financeiro confirma.
   *
   * Só vale para recebível MANUAL. Cobrança de gateway é confirmada pelo
   * webhook do provedor — baixar à mão criaria um "recebido" que o provedor
   * não reconhece (e, no Asaas, não dispararia split nem confirmação).
   */
  async settle(id: number, input: SettleInput, actor: Actor, receiptUrl?: string | null, statementRef?: string | null) {
    const record = await this.findOwned(id, actor.companyId);
    if (record.gateway !== 'manual') {
      throw new ConflictException(
        'Baixa manual só está disponível para recebíveis manuais; este é confirmado pelo gateway',
      );
    }
    if (record.inactiveAt) {
      throw new ConflictException('Conta a receber inativa: reative antes de dar baixa');
    }
    if (!OPEN_STATUSES.includes(record.status)) {
      throw new ConflictException('Esta conta a receber não está em aberto');
    }

    const paidAt = this.parsePaidAt(input.paidAt);
    // juros/multa/desconto sobre o valor esperado (líquido, se houver); sem valor recebido, ele é calculado
    const expected = Number(record.netValue ?? record.value ?? 0);
    const extras = settleExtras(expected, input as Record<string, unknown>, 'receivedValue');

    const data: Record<string, any> = {
      status: financialRecordsStatus.received,
      paidAt,
      receivedValue: extras.paidValue,
      interestValue: extras.interest,
      fineValue: extras.fine,
      discountValue: extras.discount,
      settledByUserId: actor.userId || null,
    };
    if (receiptUrl) data.receiptUrl = receiptUrl;
    if (statementRef) data.statementRef = statementRef;
    if (input.paymentMethod) {
      if (!(input.paymentMethod in paymentMethods)) {
        throw new BadRequestException('Forma de pagamento inválida');
      }
      data.paymentMethod = input.paymentMethod;
    }
    if (input.bankAccountId !== undefined && input.bankAccountId !== null && input.bankAccountId !== '') {
      await assertClassification(this.prisma, actor.companyId, { bankAccountId: input.bankAccountId });
      data.bankAccountId = Number(input.bankAccountId);
    }
    const note = input.observations?.trim();
    if (note) data.observations = note.slice(0, 255);

    // só baixa se ainda estiver em aberto: dois cliques não recebem duas vezes
    const changed = await this.prisma.financialRecords.updateMany({
      where: { id, companyId: actor.companyId, status: { in: OPEN_STATUSES }, inactiveAt: null },
      data,
    });
    if (changed.count === 0) throw new ConflictException('Esta conta a receber não está em aberto');
    const updated = await this.prisma.financialRecords.findUnique({ where: { id } });
    // o cliente pagou: a comissão do vendedor, se houver, é liberada na carteira
    await this.wallet.syncRecordSafe(id);
    return updated;
  }

  /** Estorno da baixa: desfaz um lançamento feito errado. Volta a ficar em aberto. */
  async unsettle(id: number, actor: Actor) {
    const record = await this.findOwned(id, actor.companyId);
    if (record.gateway !== 'manual') {
      throw new ConflictException('Só é possível estornar a baixa de recebíveis manuais');
    }
    if (record.status !== financialRecordsStatus.received) {
      throw new ConflictException('Esta conta a receber não está baixada');
    }
    const updated = await this.prisma.update(
      'financialRecords',
      {
        status: financialRecordsStatus.waiting,
        paidAt: null,
        receivedValue: null,
        interestValue: null,
        fineValue: null,
        discountValue: null,
        statementRef: null,
        settledByUserId: null,
        bankAccountId: null,
      },
      actor,
      null,
      id,
    );
    // baixa desfeita: a comissão volta a ficar prevista
    await this.wallet.syncRecordSafe(id);
    return updated;
  }

  /** Baixa várias de uma vez (só recebíveis manuais em aberto), cada uma pelo valor esperado. */
  async bulkSettle(actor: Actor, body: Record<string, any>) {
    const ids = idList(body.ids);
    const settled: number[] = [];
    const skipped: Array<{ id: number; reason: string }> = [];
    for (const id of ids) {
      try {
        await this.settle(id, { paidAt: body.paidAt, bankAccountId: body.bankAccountId, paymentMethod: body.paymentMethod }, actor);
        settled.push(id);
      } catch (error) {
        if (error instanceof BadRequestException && !settled.length && !skipped.length) throw error;
        skipped.push({ id, reason: (error as Error).message });
      }
    }
    return { settled: settled.length, skipped };
  }

  /** Inativa vários recebíveis manuais ainda não recebidos. Cobrança do gateway é cancelada no provedor. */
  async bulkArchive(actor: Actor, body: Record<string, any>) {
    const ids = idList(body.ids);
    const rows = await this.prisma.financialRecords.findMany({ where: { id: { in: ids }, companyId: actor.companyId }, select: { id: true, status: true, gateway: true, inactiveAt: true } });
    const ok = rows.filter((r) => !r.inactiveAt && r.gateway === 'manual' && r.status !== 'received').map((r) => r.id);
    if (ok.length) await this.prisma.financialRecords.updateMany({ where: { id: { in: ok }, companyId: actor.companyId, status: { not: 'received' } }, data: { inactiveAt: new Date() } });
    for (const id of ok) await this.wallet.syncRecordSafe(id);
    const skipped = ids.filter((id) => !ok.includes(id)).map((id) => {
      const row = rows.find((r) => r.id === id);
      const reason = !row ? 'Não encontrada' : row.inactiveAt ? 'Já inativa' : row.status === 'received' ? 'Já recebida: estorne antes' : 'Cobrança do gateway: cancele no provedor';
      return { id, reason };
    });
    return { archived: ok.length, skipped };
  }

  private parsePaidAt(value?: string): Date {
    if (!value) return new Date();
    // Data só com dia: meio-dia UTC, para não cair no dia anterior no fuso do Brasil.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00.000Z`)
      : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Data de pagamento inválida');
    if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Data de pagamento não pode ser futura');
    }
    return date;
  }
}
