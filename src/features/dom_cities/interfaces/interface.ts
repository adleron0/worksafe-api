import {
  DOM_Cities as Prisma,
  DOM_States,
  Customer as Customers,
} from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  customers: Customers[];
  states: DOM_States[];
}

// Tipos auxiliares
export type Customer = Customers;
export type State = DOM_States;
