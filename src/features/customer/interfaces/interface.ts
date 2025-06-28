import {
  Customer as Prisma,
  DOM_Ranks,
  DOM_States,
  DOM_Cities,
  DOM_Roles,
  Customer_Contacts,
} from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  contacts: Customer_Contacts[];
  rank: DOM_Ranks;
  state: DOM_States;
  city: DOM_Cities;
  role: DOM_Roles;
}

// Tipos auxiliares
export type Contact = Customer_Contacts;
export type Rank = DOM_Ranks;
export type State = DOM_States;
export type City = DOM_Cities;
export type Role = DOM_Roles;
