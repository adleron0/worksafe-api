import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { InvoiceOriginService } from './invoice.origin';
import { FiscalInvoiceService } from './invoice.service';
import { FiscalSettingsService } from './settings.service';

/**
 * Emissão automática da nota da inscrição paga (turma aberta), para quem ligou
 * a opção na configuração fiscal. Só pega pagamentos de depois de ligar. Cada
 * inscrição vira um rascunho e é emitida; se faltar dado (CPF, endereço), o
 * rascunho fica na fila "Notas a emitir" para alguém completar, sem tentar de
 * novo a cada rodada.
 */
@Injectable()
export class FiscalTrainingJob {
  private readonly logger = new Logger(FiscalTrainingJob.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: FiscalSettingsService,
    private readonly origins: InvoiceOriginService,
    private readonly invoices: FiscalInvoiceService,
  ) {}

  @Cron('0 */10 * * * *')
  async tick() {
    if (this.running || process.env.FISCAL_AUTO_EMIT_DISABLED === 'true') return;
    this.running = true;
    try {
      // cada CNPJ do grupo liga a emissão automática na própria configuração
      const rows = await this.prisma.fiscal_Settings.findMany({ where: { autoEmitTraining: true }, select: { companyId: true, entityId: true, autoEmitTrainingSince: true, updatedByUserId: true } });
      for (const row of rows) await this.runCompany(row.companyId, row.autoEmitTrainingSince, row.updatedByUserId ?? 0, row.entityId);
    } catch (error) {
      this.logger.warn(`Emissão automática de treinamento falhou: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running = false;
    }
  }

  /** Uma rodada para uma empresa (também usada nos testes). Devolve quantas notas tentou. */
  async runCompany(companyId: number, since: Date | null, userId: number, entityId?: number | null): Promise<number> {
    const id = await this.settings.entityOf(companyId, entityId ?? undefined);
    const info = await this.settings.get(companyId, id);
    if (!info.ready) return 0;
    // só as inscrições das turmas deste CNPJ (as outras saem pela configuração do outro)
    const pending = (await this.origins.pendingTraining(companyId, { since, limit: 50, entityId: id })).filter((p) => !p.invoice);
    const actor = { companyId, userId };
    let tried = 0;
    for (const item of pending) {
      try {
        const body = await this.origins.suggest(companyId, { kind: 'subscriptions', subscriptionIds: String(item.subscriptionId) });
        const draft = await this.invoices.create(actor, body as unknown as Record<string, unknown>);
        tried++;
        await this.invoices.emit(actor, draft.id).catch((error) => this.logger.warn(`Nota automática ${draft.id} ficou em rascunho: ${error instanceof Error ? error.message : error}`));
      } catch (error) {
        this.logger.warn(`Inscrição ${item.subscriptionId} sem nota automática: ${error instanceof Error ? error.message : error}`);
      }
    }
    return tried;
  }
}
