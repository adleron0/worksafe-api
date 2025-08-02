/* eslint-disable */
import { Profile as Prisma } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  // Example: customers: Customer[];
}

// Tipos auxiliares
// Example: export type Customer = Customers;
