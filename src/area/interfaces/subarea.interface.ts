import {
  SubArea as PrismaSubArea,
  Confinus_ConfinedSpace,
} from '@prisma/client';

// Extender a interface Area do Prisma
export interface SubArea extends PrismaSubArea {
  confinedSpaces?: Confinus_ConfinedSpace[];
}
