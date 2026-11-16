import { Injectable } from '@nestjs/common';
import { CommercialSection } from './commercial.section';
import { FinanceSection } from './finance.section';
import { OperationsSection } from './operations.section';
import { PeopleSection } from './people.section';
import { WeekSection } from './week.section';
import { DashboardActor, todayBr } from './shared';

/** Quem vê turmas no resumo: qualquer uma das permissões de leitura de treinamentos. */
export const TRAINING_PERMISSIONS = ['list_classes', 'list_treinamentos', 'view_treinamentos'];

/**
 * Resumo da empresa para a tela inicial. Cada seção só é montada para quem tem
 * a permissão daquela área; as que a pessoa não vê nem chegam na resposta.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly finance: FinanceSection,
    private readonly commercial: CommercialSection,
    private readonly operations: OperationsSection,
    private readonly people: PeopleSection,
    private readonly week: WeekSection,
  ) {}

  async summary(actor: DashboardActor) {
    const can = (p: string) => actor.permissions.includes(p);
    const canSeeTraining = TRAINING_PERMISSIONS.some(can);
    const today = todayBr();
    const [y, m, d] = today.split('-').map(Number);
    const skip = Promise.resolve(undefined);

    const [finance, commercial, operations, team, training, week] = await Promise.all([
      can('list_financeiro') ? this.finance.build(actor, today) : skip,
      can('list_comercial') ? this.commercial.build(actor, today) : skip,
      can('list_ordens_de_servico') ? this.operations.build(actor, today) : skip,
      can('view_alocacao') ? this.people.team(actor, today) : skip,
      canSeeTraining ? this.people.training(actor, today) : skip,
      this.week.build(actor, today, canSeeTraining),
    ]);

    return {
      today,
      monthDay: d,
      monthDays: new Date(Date.UTC(y, m, 0)).getUTCDate(),
      finance,
      commercial,
      operations,
      team,
      training,
      week,
    };
  }
}
