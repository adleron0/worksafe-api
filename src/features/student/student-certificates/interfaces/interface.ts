export interface IEntity {
  id?: number;
  traineeId?: number;
  courseId?: number;
  courseClassId?: number;
  certificateNumber?: string;
  issuedAt?: Date;
  validUntil?: Date;
  grade?: number;
  status?: string;
  certificateUrl?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
