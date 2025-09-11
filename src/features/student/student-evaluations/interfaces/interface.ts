export interface IEntity {
  id?: number;
  traineeId?: number;
  lessonId?: number;
  courseClassId?: number;
  evaluationType?: string;
  questions?: any;
  answers?: any;
  score?: number;
  maxScore?: number;
  passed?: boolean;
  attempts?: number;
  startedAt?: Date;
  completedAt?: Date;
  timeSpent?: number;
  feedback?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
