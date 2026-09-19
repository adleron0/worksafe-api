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
// Entidades migradas para o núcleo genérico (@adleron/crud-core)
import { CrudModule } from './common/crud/crud.module';
import { FileInterceptor } from '@nestjs/platform-express';
import { UseInterceptors } from '@nestjs/common';
import { Cache, CacheEvictAll } from './common/cache';
import { getMulterOptions } from './features/upload/upload.middleware';
import { customerEntity } from './features/clientes/customer/rules.crud';
import { ranksEntity } from './features/dom_ranks/rules.crud';
import { rolesEntity } from './features/dom_roles/rules.crud';
import { statesEntity } from './features/dom_states/rules.crud';
import { citiesEntity } from './features/dom_cities/rules.crud';
import { siteServicesEntity } from './features/site/site_services/rules.crud';
import { siteProductsEntity } from './features/site/site_loja/rules.crud';
import { instructorEntity } from './features/training/instructor/rules.crud';
import { InstructorSignatureController } from './features/training/instructor/signature.controller';
import { couponEntity } from './features/training/coupon/rules.crud';
import { getOptimizedMulterOptions } from './features/upload/upload.middleware';

const uploadOptimized = UseInterceptors(FileInterceptor('image', getOptimizedMulterOptions()));
const evict = (prefix: string, route: string) => CacheEvictAll(`${prefix}:*`, `cache:*/${route}*`);

const upload = (folder: string) => UseInterceptors(FileInterceptor('image', getMulterOptions(folder)));
const evictSiteServices = CacheEvictAll('site-services:*', 'cache:*/site-services*');
import { CustomerContactsModule } from './features/clientes/customer_contacts/module';
import { ProfileModule } from './features/users/profile/module';
import { CourseModule } from './features/training/course/module';
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
import { EnumsModule } from './features/enums/enums.module';
import { OnlinelessonstepModule } from './features/training/onlinelessonstep/module';
import { CouponModule } from './features/training/coupon/module';

// Rotas de alunos
import { StudentModule } from './features/student/student/module';
import { StudentCoursesModule } from './features/student/student-courses/module';
import { StudentLessonsModule } from './features/student/student-lessons/module';
import { StudentProgressModule } from './features/student/student-progress/module';
import { StudentCertificatesModule } from './features/student/student-certificates/module';
import { StudentEvaluationsModule } from './features/student/student-evaluations/module';

// Rotas do Blog
import { CategoryModule } from './features/blog/category/module';
import { TagModule } from './features/blog/tag/module';
import { PostModule } from './features/blog/post/module';
import { VisitorModule } from './features/blog/visitor/module';
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
    CrudModule.forEntities([
      { rules: customerEntity, controller: { decorators: {
        create: [upload('custumer-logo')], update: [upload('custumer-logo')] } } },
      ranksEntity,
      rolesEntity,
      statesEntity,
      citiesEntity,
      { rules: siteServicesEntity, controller: { decorators: {
        list: [Cache({ prefix: 'site-services', ttl: 172800 })],
        create: [upload('services-image'), evictSiteServices],
        update: [upload('services-image'), evictSiteServices],
        archive: [evictSiteServices],
        restore: [evictSiteServices],
      } } },
      { rules: siteProductsEntity, controller: { decorators: {
        list: [Cache({ prefix: 'site-products', ttl: 172800 })],
        create: [upload('site_products-image'), evict('site-products', 'site-products')],
        update: [upload('site_products-image'), evict('site-products', 'site-products')],
        archive: [evict('site-products', 'site-products')],
        restore: [evict('site-products', 'site-products')],
      } } },
      { rules: instructorEntity, controller: { decorators: {
        create: [uploadOptimized], update: [uploadOptimized] } } },
      { rules: couponEntity, controller: { decorators: {
        create: [evict('coupon', 'coupon')], update: [evict('coupon', 'coupon')],
        archive: [evict('coupon', 'coupon')], restore: [evict('coupon', 'coupon')],
      } } },
    ], [InstructorSignatureController]),
    CustomerContactsModule,
    ProfileModule,
    CourseModule,
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
    EnumsModule,
    OnlinelessonstepModule,
    StudentModule,
    StudentCoursesModule,
    StudentLessonsModule,
    StudentProgressModule,
    StudentCertificatesModule,
    StudentEvaluationsModule,
    CouponModule,
    // Blog
    CategoryModule,
    TagModule,
    PostModule,
    VisitorModule,
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
