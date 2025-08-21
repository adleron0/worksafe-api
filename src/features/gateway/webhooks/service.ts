import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { gateways } from '@prisma/client';

@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async registerWebhook(
    gateway: string,
    companyId: number,
    payload: any,
  ): Promise<any> {
    try {
      const webhook = await this.prisma.webhooks.create({
        data: {
          companyId,
          gateway: gateway as gateways,
          payload,
          error: null,
          processedAt: null,
        },
      });

      return {
        success: true,
        webhookId: webhook.id,
        message: 'Webhook registrado com sucesso',
      };
    } catch (error) {
      await this.prisma.webhooks.create({
        data: {
          companyId,
          gateway: gateway as gateways,
          payload,
          error: error as any,
          processedAt: new Date(),
        },
      });

      return {
        success: false,
        message: 'Webhook registrado com erro',
        error: error,
      };
    }
  }
}