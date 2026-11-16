import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { StockPpeService } from './ppe.service';
import { StockRentalService } from './rental.service';
import { StockInventoryService } from './inventory.service';
import { StockCatalogService } from './catalog.service';
import { StockMovementService } from './movement.service';
import { StockEquipmentService } from './equipment.service';

/** Estoque de equipamentos e materiais (Suprimentos). */
@Module({
  imports: [PrivateStorageModule],
  providers: [StockCatalogService, StockMovementService, StockEquipmentService, StockPpeService, StockRentalService, StockInventoryService],
  exports: [StockCatalogService, StockMovementService, StockEquipmentService, StockPpeService, StockRentalService, StockInventoryService],
})
export class StockModule {}
