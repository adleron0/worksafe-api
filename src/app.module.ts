import { Module } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { UserModule } from './features/users/user/module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { SecurityModule } from './common/security/security.module';
import { PermissionsModule } from './features/users/permissions/permissions.module';
import { UploadModule } from './features/upload/upload.module';
import { AreaModule } from './features/area/area.module';
// Entidades servidas pelo núcleo genérico (@adleron/crud-core) — ver common/crud/entities.registry.ts
import { CrudModule } from './common/crud/crud.module';
import { crudEntities, crudExtraControllers, crudExtraImports } from './common/crud/entities.registry';
import { CourseModule } from './features/training/course/module';
import { ClassesModule } from './features/training/classes/module';
import { CacheModule } from './common/cache';
import { ImageModule } from './features/image/module';
import { SubscriptionModule } from './features/training/subscription/module';
import { AlunosModule } from './features/training/trainees/module';
import { ExamesModule } from './features/training/exames/module';
import { TraineeCertificateModule } from './features/training/trainee_certificate/module';
import { ReviewsModule } from './features/training/reviews/module';
import { CompanygatewaysModule } from './features/gateway/companygateways/module';
import { WebhooksModule } from './features/gateway/webhooks/module';
import { FinancialrecordsModule } from './features/gateway/financialrecords/module';
import { CompanyModule } from './features/company/module';
import { EmailModule } from './features/email/email.module';
import { EnumsModule } from './features/enums/enums.module';
import { CouponModule } from './features/training/coupon/module';

// Rotas de alunos
import { StudentModule } from './features/student/student/module';
import { StudentCoursesModule } from './features/student/student-courses/module';
import { StudentLessonsModule } from './features/student/student-lessons/module';
import { StudentProgressModule } from './features/student/student-progress/module';
import { StudentCertificatesModule } from './features/student/student-certificates/module';
import { StudentEvaluationsModule } from './features/student/student-evaluations/module';

// Rotas do Blog
import { PostModule } from './features/blog/post/module';
import { CommentModule } from './features/blog/comment/module';
import { BlogAuthModule } from './features/blog/auth/auth.module';

// AI
import { AIModule } from './common/ai';

@Module({
  imports: [
    SecurityModule, // Módulo de segurança primeiro
    CacheModule,
    UserModule,
    PrismaModule,
    AuthModule,
    PermissionsModule,
    UploadModule,
    AreaModule,
    CrudModule.forEntities(crudEntities, crudExtraControllers, crudExtraImports),
    CourseModule,
    ClassesModule,
    ImageModule,
    SubscriptionModule,
    AlunosModule,
    ExamesModule,
    TraineeCertificateModule,
    ReviewsModule,
    CompanygatewaysModule,
    WebhooksModule,
    FinancialrecordsModule,
    CompanyModule,
    EmailModule,
    EnumsModule,
    StudentModule,
    StudentCoursesModule,
    StudentLessonsModule,
    StudentProgressModule,
    StudentCertificatesModule,
    StudentEvaluationsModule,
    CouponModule,
    // Blog
    PostModule,
    CommentModule,
    BlogAuthModule,
    // AI
    AIModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
