import { DOM_Ranks as Prisma, Customer as Customers } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  customers: Customers[];
}

// Tipos auxiliares
export type Customer = Customers;
