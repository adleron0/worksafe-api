export interface IEntity {
  id: number;
  traineeId: number;
  stepId: number;
  lessonId: number;
  companyId: number;
  progressPercent: number;
  progressData: any;
  firstAccessAt?: Date | null;
  lastAccessAt: Date;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  inactiveAt?: Date | null;
}
