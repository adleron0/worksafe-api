import { Controller, Get, Param, HttpException, HttpStatus } from '@nestjs/common';
import { EnumsService } from './enums.service';
import { Public } from 'src/auth/decorators/public.decorator';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('Enums')
@Controller('enums')
@SkipThrottle() // Skip rate limiting para esta rota
export class EnumsController {
  constructor(private readonly enumsService: EnumsService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Retorna todos os enums disponíveis' })
  @ApiResponse({ 
    status: 200, 
    description: 'Lista de todos os enums',
    schema: {
      type: 'object',
      example: {
        success: true,
        data: {
          gateways: {
            asaas: 'asaas',
            stripe: 'stripe',
            efi: 'efi',
            mercadoPago: 'mercadoPago',
            pagSeguro: 'pagSeguro',
            paypal: 'paypal'
          },
          paymentMethods: {
            cartaoCredito: 'cartaoCredito',
            boleto: 'boleto',
            pix: 'pix'
          }
        }
      }
    }
  })
  getAllEnums() {
    try {
      const enums = this.enumsService.getAllEnums();
      return {
        success: true,
        data: enums,
        count: Object.keys(enums).length
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar enums',
          error: error.message
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('names')
  @Public()
  @ApiOperation({ summary: 'Retorna apenas os nomes dos enums disponíveis' })
  @ApiResponse({ 
    status: 200, 
    description: 'Lista com os nomes dos enums',
    schema: {
      type: 'object',
      example: {
        success: true,
        data: ['gateways', 'paymentMethods', 'financialRecordsStatus', 'ContentType', 'LessonProgressStatus']
      }
    }
  })
  getEnumNames() {
    try {
      const names = this.enumsService.getEnumNames();
      return {
        success: true,
        data: names,
        count: names.length
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Erro ao buscar nomes dos enums',
          error: error.message
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get(':enumName')
  @Public()
  @ApiOperation({ summary: 'Retorna um enum específico pelo nome' })
  @ApiParam({ 
    name: 'enumName', 
    description: 'Nome do enum a ser buscado',
    example: 'paymentMethods'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Enum solicitado',
    schema: {
      type: 'object',
      example: {
        success: true,
        data: {
          cartaoCredito: 'cartaoCredito',
          boleto: 'boleto',
          pix: 'pix'
        }
      }
    }
  })
  @ApiResponse({ 
    status: 404, 
    description: 'Enum não encontrado'
  })
  getEnum(@Param('enumName') enumName: string) {
    try {
      const enumData = this.enumsService.getEnumByName(enumName);
      return {
        success: true,
        data: enumData,
        name: enumName
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message
        },
        HttpStatus.NOT_FOUND
      );
    }
  }
}