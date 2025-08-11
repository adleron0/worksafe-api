import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { UserModule } from './features/users/user/module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { CompanyModule } from './features/company/company.module';
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
import { CourseClassInstructorModule } from './features/training/course_class_instructor/module';
import { SiteProductsimagesModule } from './features/site/site_productsimages/module';
import { CacheModule } from './common/cache';
import { ImageModule } from './features/image/module';
import { CertificateModule } from './features/training/certificate/module';
import { SubscriptionModule } from './features/training/subscription/module';
import { AlunosModule } from './features/training/alunos/module';
import { ExamesModule } from './features/training/exames/module';

@Module({
  imports: [
    CacheModule,
    UserModule,
    PrismaModule,
    AuthModule,
    CompanyModule,
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
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser()).forRoutes('*');
  }
}
