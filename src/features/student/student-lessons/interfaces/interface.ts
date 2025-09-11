export interface IEntity {
  id: number;
  name: string;
  description?: string;
  duration?: number;
  order: number;
  content?: string;
  videoUrl?: string;
  materialUrl?: string;
  onlineCourseModelId: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
