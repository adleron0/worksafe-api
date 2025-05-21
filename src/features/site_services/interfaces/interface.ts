import { Site_Services as Prisma, Company as Companies } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  company: Company;
}

// Tipos auxiliares
export type Company = Companies;
