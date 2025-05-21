import {
  Area as PrismaArea,
  Company,
  CompanyProduct,
  Product,
} from '@prisma/client';

// Extender a interface Area do Prisma
export interface Area extends PrismaArea {
  company?: CompanyWithProducts;
}

// Tipos auxiliares
type CompanyWithProducts = Company & {
  products: (CompanyProduct & {
    product: Product;
  })[];
};
