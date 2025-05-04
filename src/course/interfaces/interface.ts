/* eslint-disable */
import { Course as Prisma, CouseCertificate, CourseExam, CourseReview, CourseClass, TraineeCourseCertificate } from '@prisma/client';

// Extender a interface do Prisma
export interface IEntity extends Prisma {
  certificates: CouseCertificate[];
  traineesCertificates: TraineeCourseCertificate[];
  reviews: CourseReview[];
  exams: CourseExam[];
  classes: CourseClass[];
}

// Tipos auxiliares
export type Certificate = CouseCertificate;
export type TraineeCertificate = TraineeCourseCertificate;
export type Review = CourseReview;
export type Exam = CourseExam;
export type Class = CourseClass;
