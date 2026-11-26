import { Injectable } from '@nestjs/common';
import { ActivityService } from 'src/features/commercial/activity.service';
import { PipelineService } from 'src/features/commercial/pipeline.service';
import { ProposalService } from 'src/features/commercial/proposal.service';
import { EmployeeActivityService } from 'src/features/hr/activity.service';
import { EmployeeDocumentService } from 'src/features/hr/document.service';
import { EmployeeService } from 'src/features/hr/employee.service';
import { OrderResultService } from 'src/features/operations/order-result.service';
import { DailyReportService } from 'src/features/operations/daily-report.service';
import { PurchaseOrderService } from 'src/features/operations/purchase-order.service';
import { ServiceOrderService } from 'src/features/operations/service-order.service';
import { PayableService } from 'src/features/financial/payable.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ImageIntakeService } from '../images/image-intake.service';
import { NotifyService } from '../reports/notify.service';
import { InternalApiService } from './internal-api.service';
import { InstagramService } from '../connectors/instagram.service';
import { InstagramMessagesService } from '../connectors/instagram-messages.service';

/**
 * Os serviços de domínio que as ferramentas usam. As ferramentas não
 * duplicam regra: chamam o mesmo serviço que a tela chama.
 */
/** A equipe de bots, para as ferramentas de colega (preenchido pelo AgentService ao iniciar). */
export interface TeamPort {
  askColleague(ctx: import('./tool.types').ToolContext, input: Record<string, any>): Promise<unknown>;
  handOff(ctx: import('./tool.types').ToolContext, input: Record<string, any>): Promise<unknown>;
}

/** Atendimento das Conversas (preenchido pelo ChatBotService ao iniciar). */
export interface ChatPort {
  reply(ctx: import('./tool.types').ToolContext, text: string): Promise<{ message: string }>;
  route(ctx: import('./tool.types').ToolContext, input: { setor?: string; resumo?: string; motivo?: string }): Promise<{ message: string }>;
}

@Injectable()
export class ToolDeps {
  chat?: ChatPort;
  team?: TeamPort;
  /** Memória de longo prazo (preenchido pelo MemoryService ao iniciar). */
  memory?: import('../memory/memory.service').MemoryPort;

  constructor(
    readonly prisma: PrismaService,
    readonly proposals: ProposalService,
    readonly activities: ActivityService,
    readonly pipeline: PipelineService,
    readonly orders: ServiceOrderService,
    readonly reports: DailyReportService,
    readonly results: OrderResultService,
    readonly purchases: PurchaseOrderService,
    readonly employees: EmployeeService,
    readonly documents: EmployeeDocumentService,
    readonly employeeActivities: EmployeeActivityService,
    readonly payables: PayableService,
    readonly images: ImageIntakeService,
    readonly api: InternalApiService,
    readonly notify: NotifyService,
    readonly instagram: InstagramService,
    readonly instagramMessages: InstagramMessagesService,
  ) {}
}
