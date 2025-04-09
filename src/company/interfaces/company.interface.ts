import { Product } from '@prisma/client';

export interface Company {
  id?: number;
  comercial_name: string;
  corporate_name: string;
  cnpj: string;
  region: string;
  state: string;
  products?: Product[];
  representative_email: string;
  segment: string;
}
