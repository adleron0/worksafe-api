import {
  User as PrismaUser,
  Role,
  Permission,
  UserPermission,
  RolePermission,
  Company,
  CompanyProduct,
  Product,
} from '@prisma/client';

// Extender a interface IEntity do Prisma
export interface IEntity extends PrismaUser {
  role?: RoleWithPermissions;
  permissions?: UserPermissionWithPermission[];
  company?: CompanyWithProducts;
}

// Tipos auxiliares
type RoleWithPermissions = Role & {
  permissions: (RolePermission & {
    permission: Permission;
  })[];
};

type UserPermissionWithPermission = UserPermission & {
  permission: Permission;
};

type CompanyWithProducts = Company & {
  products: (CompanyProduct & {
    product: Product;
  })[];
};
