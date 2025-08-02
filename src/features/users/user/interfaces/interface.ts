import {
  User as PrismaUser,
  Profile,
  Permission,
  UserPermission,
  ProfilePermission,
  Company,
  CompanyProduct,
  Product,
} from '@prisma/client';

// Extender a interface IEntity do Prisma
export interface IEntity extends PrismaUser {
  profile?: ProfileWithPermissions;
  permissions?: UserPermissionWithPermission[];
  company?: CompanyWithProducts;
}

// Tipos auxiliares
type ProfileWithPermissions = Profile & {
  permissions: (ProfilePermission & {
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
