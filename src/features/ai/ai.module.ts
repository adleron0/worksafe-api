import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { CommercialModule } from 'src/features/commercial/module';
import { FinancialModule } from 'src/features/financial/module';
import { HrModule } from 'src/features/hr/module';
import { OperationsModule } from 'src/features/operations/module';
import { BotService } from './bots/bot.service';
import { AgentService } from './engine/agent.service';
import { UsageService } from './engine/usage.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ToolCatalogService } from './tools/tool-catalog.service';
import { ToolDeps } from './tools/tool.deps';
import { McpOAuthService } from './mcp/mcp-oauth.service';
import { NotifyService } from './reports/notify.service';
import { ReportService } from './reports/report.service';
import { EmailModule } from 'src/features/email/email.module';
import { ScheduleModule } from '@nestjs/schedule';
import { UploadModule } from 'src/features/upload/upload.module';
import { ImageIntakeService } from './images/image-intake.service';

/** Bots de IA: catálogo de ferramentas, motor, fornecedores e gasto. */
@Module({
  imports: [ScheduleModule.forRoot(), EmailModule, UploadModule, CommercialModule, OperationsModule, HrModule, FinancialModule, PrivateStorageModule],
  providers: [ProviderRegistry, ToolDeps, ToolCatalogService, BotService, UsageService, AgentService, McpOAuthService, NotifyService, ReportService, ImageIntakeService],
  exports: [ProviderRegistry, ToolDeps, ToolCatalogService, BotService, UsageService, AgentService, McpOAuthService, NotifyService, ReportService, ImageIntakeService],
})
export class BotsAiModule {}
