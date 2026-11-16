import { Module } from '@nestjs/common';
import { StockCatalogService } from './catalog.service';
import { StockMovementService } from './movement.service';

/** Estoque de equipamentos e materiais (Suprimentos). */
@Module({ providers: [StockCatalogService, StockMovementService], exports: [StockCatalogService, StockMovementService] })
export class StockModule {}
