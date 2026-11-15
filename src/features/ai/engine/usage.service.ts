import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatUsage } from '../providers/provider.types';

export const monthOf = (date = new Date()) => new Date(date.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);

/** Gasto com IA por mês e o teto (AI_MONTHLY_BUDGET_USD, padrão US$ 50). */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  budget(): number {
    const value = Number(process.env.AI_MONTHLY_BUDGET_USD);
    return Number.isFinite(value) && value >= 0 ? value : 50;
  }

  async record(companyId: number, provider: string, model: string, usage: ChatUsage, cost: number): Promise<void> {
    const month = monthOf();
    await this.prisma.ai_Usage.upsert({
      where: { companyId_month_provider_model: { companyId, month, provider, model } },
      create: { companyId, month, provider, model, calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost },
      update: { calls: { increment: 1 }, inputTokens: { increment: usage.inputTokens }, outputTokens: { increment: usage.outputTokens }, costUsd: { increment: cost } },
    });
  }

  async spent(companyId: number, month = monthOf()): Promise<number> {
    const sum = await this.prisma.ai_Usage.aggregate({ where: { companyId, month }, _sum: { costUsd: true } });
    return Number(sum._sum.costUsd ?? 0);
  }

  async overBudget(companyId: number): Promise<boolean> {
    return (await this.spent(companyId)) >= this.budget();
  }

  async summary(companyId: number, month = monthOf()) {
    const rows = await this.prisma.ai_Usage.findMany({ where: { companyId, month }, orderBy: { costUsd: 'desc' } });
    const spent = rows.reduce((sum, row) => sum + Number(row.costUsd), 0);
    const budget = this.budget();
    return {
      month, budget, spent: Number(spent.toFixed(4)), percent: budget > 0 ? Math.round((spent / budget) * 100) : null,
      rows: rows.map((row) => ({ provider: row.provider, model: row.model, calls: row.calls, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: Number(Number(row.costUsd).toFixed(4)) })),
    };
  }
}
