/* eslint-disable */
import {
  Instructor as Prisma,
  CourseClassInstructor as CourseClassInstructors,
} from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  classes: CourseClassInstructors[];
}

// Tipos auxiliares
export type CourseClassInstructor = CourseClassInstructors;
