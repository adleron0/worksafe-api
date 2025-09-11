import { applyDecorators, UseGuards } from '@nestjs/common';
import { StudentAuthGuard } from '../guards/student-auth.guard';

export const StudentAuth = () => applyDecorators(UseGuards(StudentAuthGuard));
