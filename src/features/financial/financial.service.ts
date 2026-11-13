import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChartAccountService } from './chart-account.service';
import { CLASSIFICATION_ORIGINS, ClassificationOrigin, assertClassification } from './classification';

@Injectable()
export class FinancialService {
  constructor(private readonly prisma: PrismaService, private readonly chart: ChartAccountService) {}

  /**
   * Saldo gerencial de cada conta: saldo inicial + o que foi baixado nela.
   * Conta do tipo gateway soma também o que o provedor confirmou (esses
   * recebíveis não passam pela baixa manual, então não têm conta gravada).
   */
  async bankBalances(companyId: number) {
    const accounts = await this.prisma.financial_BankAccount.findMany({ where: { companyId } });
    const out: Array<{ id: number; balance: number; received: number }> = [];
    for (const account of accounts) {
      const since = account.openingBalanceDate ? { paidAt: { gte: account.openingBalanceDate } } : {};
      const base = { companyId, status: 'received' as const, inactiveAt: null, ...since };
      const settled = await this.prisma.financialRecords.findMany({
        where: { ...base, bankAccountId: account.id }, select: { value: true, netValue: true, receivedValue: true },
      });
      const viaGateway = account.type === 'gateway' && account.gateway
        ? await this.prisma.financialRecords.findMany({
          where: { ...base, bankAccountId: null, gateway: account.gateway }, select: { value: true, netValue: true, receivedValue: true },
        })
        : [];
      const received = [...settled, ...viaGateway]
        .reduce((sum, r) => sum + Number(r.receivedValue ?? r.netValue ?? r.value ?? 0), 0);
      out.push({
        id: account.id,
        received: Math.round(received * 100) / 100,
        balance: Math.round((Number(account.openingBalance) + received) * 100) / 100,
      });
    }
    return out;
  }

  async classificationDefaults(companyId: number) {
    await this.chart.ensureSeed(companyId);
    const rows = await this.prisma.financial_ClassificationDefault.findMany({
      where: { companyId },
      include: { chartAccount: { select: { id: true, code: true, name: true } }, costCenter: { select: { id: true, name: true } } },
    });
    const pending = await this.prisma.financialRecords.count({ where: { companyId, chartAccountId: null, subscriptionId: { not: null } } });
    return {
      pendingSubscriptionRecords: pending,
      rows: CLASSIFICATION_ORIGINS.map(({ origin, label }) => {
        const row = rows.find((r) => r.origin === origin);
        return {
          origin, label,
          chartAccountId: row?.chartAccountId ?? null, chartAccount: row?.chartAccount ?? null,
          costCenterId: row?.costCenterId ?? null, costCenter: row?.costCenter ?? null,
        };
      }),
    };
  }

  private parseOrigin(origin: string): ClassificationOrigin {
    if (!CLASSIFICATION_ORIGINS.some((o) => o.origin === origin)) throw new BadRequestException('Origem inválida');
    return origin as ClassificationOrigin;
  }

  async setClassificationDefault(companyId: number, originRaw: string, input: { chartAccountId?: unknown; costCenterId?: unknown }) {
    const origin = this.parseOrigin(originRaw);
    const id = (value: unknown) => (value === undefined || value === null || value === '' ? null : Number(value));
    const data = { chartAccountId: id(input.chartAccountId), costCenterId: id(input.costCenterId) };
    await assertClassification(this.prisma, companyId, data);
    return this.prisma.financial_ClassificationDefault.upsert({
      where: { companyId_origin: { companyId, origin } },
      update: data,
      create: { companyId, origin, ...data },
    });
  }

  /**
   * Aplica a classificação padrão de inscrição aos recebíveis de inscrição
   * que ainda não têm conta/centro de custo (os anteriores ao cadastro).
   * Só preenche o que está vazio; nunca sobrescreve.
   */
  async applyDefaultsToSubscriptions(companyId: number) {
    const row = await this.prisma.financial_ClassificationDefault.findUnique({ where: { companyId_origin: { companyId, origin: 'inscricao' } } });
    if (!row || (!row.chartAccountId && !row.costCenterId)) {
      throw new BadRequestException('Defina antes a classificação padrão de inscrição');
    }
    await assertClassification(this.prisma, companyId, { chartAccountId: row.chartAccountId, costCenterId: row.costCenterId });
    const base = { companyId, subscriptionId: { not: null } };
    const accounts = row.chartAccountId
      ? (await this.prisma.financialRecords.updateMany({ where: { ...base, chartAccountId: null }, data: { chartAccountId: row.chartAccountId } })).count
      : 0;
    const centers = row.costCenterId
      ? (await this.prisma.financialRecords.updateMany({ where: { ...base, costCenterId: null }, data: { costCenterId: row.costCenterId } })).count
      : 0;
    return { chartAccount: accounts, costCenter: centers };
  }
}
