import { DOM_Roles as Prisma, Customer as Customers } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  customers: Customers[];
}

// Tipos auxiliares
export type Customer = Customers;
