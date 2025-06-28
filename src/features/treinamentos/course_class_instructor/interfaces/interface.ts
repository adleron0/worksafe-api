/* eslint-disable */
import { CourseClassInstructor as Prisma, CourseClass as Class, Instructor as ClassInstructor } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  // Add relations here as needed
  class: Class;
  instructor: Instructor;
}

// Tipos auxiliares
// Example: export type Customer = Customers;
export type CourseClass = Class;
export type Instructor = ClassInstructor;
