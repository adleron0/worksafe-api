import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { UserModule } from './user/module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { CompanyModule } from './company/company.module';
import { PermissionsModule } from './permissions/permissions.module';
import { UploadModule } from './upload/upload.module';
import { AreaModule } from './area/area.module';
import { CustomerModule } from './customer/module';
import { DomRanksModule } from './dom_ranks/module';
import { DomCitiesModule } from './dom_cities/module';
import { DomStatesModule } from './dom_states/module';
import { CustomerContactsModule } from './customer_contacts/module';
import { DomRolesModule } from './dom_roles/module';
import { ServicesModule } from './site_services/module';
import { SiteProductsModule } from './site_loja/module';
import { ProfileModule } from './profile/module';
import { CourseModule } from './course/module';
import { InstructorModule } from './instructor/module';
import { ClassesModule } from './classes/module';
import { CourseClassInstructorModule } from './course_class_instructor/module';
import { SiteProductsimagesModule } from './site_productsimages/module';

@Module({
  imports: [
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
