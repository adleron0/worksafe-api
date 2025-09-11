import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Decorator para pegar o traineeId do request
export const TraineeId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.traineeId;
  },
);

// Decorator para pegar todo o objeto student do request
export const CurrentStudent = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.student;
  },
);

// Decorator para pegar um campo específico do student
export const StudentField = createParamDecorator(
  (field: string, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const student = request.student;
    return field ? student?.[field] : student;
  },
);
