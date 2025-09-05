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
import { CustomerModule } from './features/clientes/customer/module';
import { DomRanksModule } from './features/dom_ranks/module';
import { DomCitiesModule } from './features/dom_cities/module';
import { DomStatesModule } from './features/dom_states/module';
import { CustomerContactsModule } from './features/clientes/customer_contacts/module';
import { DomRolesModule } from './features/dom_roles/module';
import { ServicesModule } from './features/site/site_services/module';
import { SiteProductsModule } from './features/site/site_loja/module';
import { ProfileModule } from './features/users/profile/module';
import { CourseModule } from './features/training/course/module';
import { InstructorModule } from './features/training/instructor/module';
import { ClassesModule } from './features/training/classes/module';
import { CourseClassInstructorModule } from './features/training/class_instructor/module';
import { SiteProductsimagesModule } from './features/site/site_productsimages/module';
import { CacheModule } from './common/cache';
import { ImageModule } from './features/image/module';
import { CertificateModule } from './features/training/certificate/module';
import { SubscriptionModule } from './features/training/subscription/module';
import { AlunosModule } from './features/training/trainees/module';
import { ExamesModule } from './features/training/exames/module';
import { TraineeCertificateModule } from './features/training/trainee_certificate/module';
import { ReviewsModule } from './features/training/reviews/module';
import { CompanygatewaysModule } from './features/gateway/companygateways/module';
import { WebhooksModule } from './features/gateway/webhooks/module';
import { FinancialrecordsModule } from './features/gateway/financialrecords/module';
import { ClassAttendanceListModule } from './features/training/class_attendance_list/module';
import { CompanyModule } from './features/company/module';
import { EmailModule } from './features/email/email.module';
import { OnlinelessonModule } from './features/training/onlinelesson/module';
import { OnlinecoursesModule } from './features/training/onlinecourses/module';
import { OnlinemodellessonModule } from './features/training/onlinemodellesson/module';

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
    CustomerModule,
    DomRanksModule,
    DomCitiesModule,
    DomStatesModule,
    CustomerContactsModule,
    DomRolesModule,
    ServicesModule,
    SiteProductsModule,
    ProfileModule,
    CourseModule,
    InstructorModule,
    ClassesModule,
    CourseClassInstructorModule,
    SiteProductsimagesModule,
    ImageModule,
    CertificateModule,
    SubscriptionModule,
    AlunosModule,
    ExamesModule,
    TraineeCertificateModule,
    ReviewsModule,
    CompanygatewaysModule,
    WebhooksModule,
    FinancialrecordsModule,
    ClassAttendanceListModule,
    CompanyModule,
    EmailModule,
    OnlinelessonModule,
    OnlinecoursesModule,
    OnlinemodellessonModule,
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
