import {
  DOM_States as Prisma,
  DOM_Cities,
  Customer as Customers,
} from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  customers: Customers[];
  cities: DOM_Cities[];
}

// Tipos auxiliares
export type Customer = Customers;
export type City = DOM_Cities;
