import { Injectable } from '@nestjs/common';
import { ActivityService } from 'src/features/commercial/activity.service';
import { PipelineService } from 'src/features/commercial/pipeline.service';
import { ProposalService } from 'src/features/commercial/proposal.service';
import { EmployeeActivityService } from 'src/features/hr/activity.service';
import { EmployeeDocumentService } from 'src/features/hr/document.service';
import { EmployeeService } from 'src/features/hr/employee.service';
import { OrderResultService } from 'src/features/operations/order-result.service';
import { PurchaseOrderService } from 'src/features/operations/purchase-order.service';
import { ServiceOrderService } from 'src/features/operations/service-order.service';
import { PayableService } from 'src/features/financial/payable.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ImageIntakeService } from '../images/image-intake.service';

/**
 * Os serviços de domínio que as ferramentas usam. As ferramentas não
 * duplicam regra: chamam o mesmo serviço que a tela chama.
 */
@Injectable()
export class ToolDeps {
  constructor(
    readonly prisma: PrismaService,
    readonly proposals: ProposalService,
    readonly activities: ActivityService,
    readonly pipeline: PipelineService,
    readonly orders: ServiceOrderService,
    readonly results: OrderResultService,
    readonly purchases: PurchaseOrderService,
    readonly employees: EmployeeService,
    readonly documents: EmployeeDocumentService,
    readonly employeeActivities: EmployeeActivityService,
    readonly payables: PayableService,
    readonly images: ImageIntakeService,
  ) {}
}
