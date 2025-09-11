export interface IEntity {
  id: number;
  traineeId: number;
  courseClassId: number;
  subscribedAt: Date;
  accepted: boolean;
  acceptedAt?: Date | null;
  declinedAt?: Date | null;
  declinedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
