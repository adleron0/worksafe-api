import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { UserModule } from './features/user/module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { CompanyModule } from './features/company/company.module';
import { PermissionsModule } from './features/permissions/permissions.module';
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
import { ProfileModule } from './features/profile/module';
import { CourseModule } from './features/treinamentos/course/module';
import { InstructorModule } from './features/treinamentos/instructor/module';
import { ClassesModule } from './features/treinamentos/classes/module';
import { CourseClassInstructorModule } from './features/treinamentos/course_class_instructor/module';
import { SiteProductsimagesModule } from './features/site/site_productsimages/module';
import { CacheModule } from './common/cache';
import { ImageModule } from './features/image/module';

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
