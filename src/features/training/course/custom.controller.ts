import { Controller, Get, Query } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { CourseService } from './service';

/** Lista pública de cursos por empresa/domínio (site). */
@Controller('courses')
export class CourseCustomController {
  constructor(private readonly courses: CourseService) {}
  @Public() @Get('list')
  list(@Query() query: Record<string, string>) {
    return this.courses.list(query, { model: 'course', name: 'Curso', route: 'courses', permission: 'treinamentos' });
  }
}
