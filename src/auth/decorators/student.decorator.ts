import { SetMetadata } from '@nestjs/common';

export const IS_STUDENT_ROUTE_KEY = 'isStudentRoute';
export const IsStudentRoute = () => SetMetadata(IS_STUDENT_ROUTE_KEY, true);
