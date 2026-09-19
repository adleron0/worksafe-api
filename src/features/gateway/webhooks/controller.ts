import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { WebhooksService } from './service';

@Controller('webhooks')
@SkipThrottle() // Ignora rate limiting para webhooks
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * Público por natureza (quem chama é o gateway), mas AUTENTICADO pelo token
   * do webhook: sem isto, qualquer um forjava PAYMENT_CONFIRMED e confirmava
   * matrícula sem pagar. O Asaas envia o token configurado no painel no header
   * `asaas-access-token`.
   */
  @Public()
  @Post(':gateway/:companyId')
  async registerWebhook(
    @Param('gateway') gateway: string,
    @Param('companyId') companyId: string,
    @Headers('asaas-access-token') asaasToken: string | undefined,
    @Body() payload: any,
  ) {
    const authorized = await this.webhooksService.verifyWebhookToken(
      gateway,
      Number(companyId),
      asaasToken,
    );
    if (!authorized) {
      throw new UnauthorizedException('Webhook não autorizado');
    }
    return this.webhooksService.registerWebhook(
      gateway,
      Number(companyId),
      payload,
    );
  }
}
