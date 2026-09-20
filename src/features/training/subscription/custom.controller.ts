import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { SubscriptionService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import generic controller
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'CourseClassSubscription' as keyof PrismaClient,
  name: 'Subscription',
  route: 'subscription',
  permission: 'classes',
};

/** search de duplicidade do subscribe (era getSearchParams do rules.ts). */
function getSearchParams(request: Request, dto: any) {
  return {
    companyId: request.user?.companyId ? Number(request.user.companyId) : dto.companyId ? Number(dto.companyId) : undefined,
    cpf: dto.cpf,
    classId: Number(dto.classId),
  };
}

@Controller('subscription')
export class SubscriptionCustomController {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
  }

  // ROTA ABERTA PARA INSCRIÇÃO (com checkout integrado quando allowCheckout = true)
  @Public()
  @Post('subscribe')
  @CacheEvictAll(
    'subscription:*',
    'cache:*/subscription*',
    'training-classes:*',
    'cache:*/classes*',
  ) // limpa cache de subscription e classes
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('subscription-image')),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async subscription(
    @Req() request: Request,
    @Body() body: any,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    // Converte strings JSON para objetos quando vem do FormData
    if (typeof body.creditCard === 'string') {
      if (
        body.creditCard === '[object Object]' ||
        body.creditCard === '' ||
        body.creditCard === 'undefined'
      ) {
        // Se for string vazia ou inválida, remove o campo
        delete body.creditCard;
      } else {
        try {
          body.creditCard = JSON.parse(body.creditCard);
        } catch (e) {
          console.error('Erro ao fazer parse de creditCard:', e);
          console.error('String recebida:', body.creditCard);
          delete body.creditCard; // Remove se não conseguir fazer parse
        }
      }
    }

    if (typeof body.customerData === 'string') {
      try {
        body.customerData = JSON.parse(body.customerData);
      } catch (e) {
        // Ignora erro, deixa como undefined
        body.customerData = undefined;
      }
    }

    // Converte campos numéricos se necessário
    if (body.classId) {
      body.classId = Number(body.classId);
    }

    if (body.companyId) {
      body.companyId = Number(body.companyId);
    }

    // Garante que couponCode seja string se existir
    if (body.couponCode && typeof body.couponCode !== 'string') {
      body.couponCode = String(body.couponCode);
    }

    // Debug: verificar campos recebidos
    console.log('=== BODY RECEBIDO NA SUBSCRIPTION ===');
    console.log('couponCode:', body.couponCode);
    console.log('paymentMethod:', body.paymentMethod);
    console.log('=====================================');

    const CreateDto = body as any;
    CreateDto.subscribeStatus = 'pending';
    const search = getSearchParams(request, CreateDto);
    return this.Service.subscription(search, entity, CreateDto);
  }
}