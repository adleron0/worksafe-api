import { Global, Module } from '@nestjs/common';
import { SellerWalletService } from './wallet.service';

/**
 * Carteira do vendedor. Global porque a comissão é sincronizada de vários lugares
 * (checkout, webhook, baixa manual, faturamento de contrato, cadastro de contas a
 * receber) e nenhum deles deveria precisar importar o módulo comercial inteiro.
 */
@Global()
@Module({ providers: [SellerWalletService], exports: [SellerWalletService] })
export class SellerWalletModule {}
