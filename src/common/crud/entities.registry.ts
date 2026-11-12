/**
 * Registro das entidades servidas pelo núcleo genérico (@adleron/crud-core).
 * Cada linha é uma entidade: as regras e, quando preciso, os decorators por
 * op (upload, cache, evicção) — concerns do projeto, fora do núcleo.
 */
import { UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AIModule } from 'src/common/ai';
import { Cache, CacheEvictAll } from 'src/common/cache';
import { ImageOptimizationInterceptor } from 'src/features/upload/image-optimization.interceptor';
import { UploadModule } from 'src/features/upload/upload.module';
import { getMulterOptions, getOptimizedMulterOptions } from 'src/features/upload/upload.middleware';

import { blogCategoryEntity } from 'src/features/blog/category/rules.crud';
import { CommentCustomController } from 'src/features/blog/comment/custom.controller';
import { CommentModule } from 'src/features/blog/comment/module';
import { blogCommentEntity } from 'src/features/blog/comment/rules.crud';
import { PostCustomController } from 'src/features/blog/post/custom.controller';
import { PostModule } from 'src/features/blog/post/module';
import { blogPostEntity } from 'src/features/blog/post/rules.crud';
import { blogTagEntity } from 'src/features/blog/tag/rules.crud';
import { VisitorCustomController } from 'src/features/blog/visitor/custom.controller';
import { blogVisitorEntity } from 'src/features/blog/visitor/rules.crud';
import { customerEntity } from 'src/features/clientes/customer/rules.crud';
import { citiesEntity } from 'src/features/dom_cities/rules.crud';
import { ranksEntity } from 'src/features/dom_ranks/rules.crud';
import { rolesEntity } from 'src/features/dom_roles/rules.crud';
import { statesEntity } from 'src/features/dom_states/rules.crud';
import { siteProductsEntity } from 'src/features/site/site_loja/rules.crud';
import { siteProductBrandEntity, siteProductCategoryEntity } from 'src/features/site/site_loja/taxonomy.rules';
import { siteServicesEntity } from 'src/features/site/site_services/rules.crud';
import { couponEntity } from 'src/features/training/coupon/rules.crud';
import { instructorEntity } from 'src/features/training/instructor/rules.crud';
import { InstructorSignatureController } from 'src/features/training/instructor/signature.controller';
import { userEntity } from 'src/features/users/user/rules.crud';
import { profileEntity } from 'src/features/users/profile/rules.crud';
import { customerContactsEntity } from 'src/features/clientes/customer_contacts/rules.crud';
import { imageEntity } from 'src/features/image/rules.crud';
import { ImageCustomController } from 'src/features/image/custom.controller';
import { ImageModule } from 'src/features/image/module';
import { companyEntity } from 'src/features/company/rules.crud';
import { CompanyCustomController } from 'src/features/company/custom.controller';
import { CompanyModule } from 'src/features/company/module';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { siteProductImagesEntity } from 'src/features/site/site_productsimages/rules.crud';
import { classInstructorEntity } from 'src/features/training/class_instructor/rules.crud';
import { reviewEntity } from 'src/features/training/reviews/rules.crud';
import { ReviewsCustomController } from 'src/features/training/reviews/custom.controller';
import { ReviewsModule } from 'src/features/training/reviews/module';
import { courseEntity } from 'src/features/training/course/rules.crud';
import { CourseCustomController } from 'src/features/training/course/custom.controller';
import { CourseModule } from 'src/features/training/course/module';
import { traineeEntity } from 'src/features/training/trainees/rules.crud';
import { examEntity } from 'src/features/training/exames/rules.crud';
import { ExamesCustomController } from 'src/features/training/exames/custom.controller';
import { ExamesModule } from 'src/features/training/exames/module';
import { certificateTemplateEntity } from 'src/features/training/certificate/rules.crud';
import { attendanceEntity } from 'src/features/training/class_attendance_list/rules.crud';
import { AttendanceCustomController } from 'src/features/training/class_attendance_list/custom.controller';
import { onlineCourseModelEntity } from 'src/features/training/onlinecourses/rules.crud';
import { onlineLessonEntity } from 'src/features/training/onlinelesson/rules.crud';
import { onlineLessonStepEntity } from 'src/features/training/onlinelessonstep/rules.crud';
import { onlineModelLessonEntity } from 'src/features/training/onlinemodellesson/rules.crud';
import { OnlineModelLessonCustomController } from 'src/features/training/onlinemodellesson/custom.controller';
import { classEntity } from 'src/features/training/classes/rules.crud';
import { ClassesCustomController } from 'src/features/training/classes/custom.controller';
import { ClassesModule } from 'src/features/training/classes/module';
import { subscriptionEntity } from 'src/features/training/subscription/rules.crud';
import { SubscriptionCustomController } from 'src/features/training/subscription/custom.controller';
import { SubscriptionModule } from 'src/features/training/subscription/module';
import { traineeCertificateEntity } from 'src/features/training/trainee_certificate/rules.crud';
import { TraineeCertificateCustomController } from 'src/features/training/trainee_certificate/custom.controller';
import { TraineeCertificateModule } from 'src/features/training/trainee_certificate/module';
import { Throttle } from '@nestjs/throttler';
import { studentGuard } from './student-scope';
import { companyGatewayEntity } from 'src/features/gateway/companygateways/rules.crud';
import { financialRecordEntity } from 'src/features/gateway/financialrecords/rules.crud';
import { FinancialRecordsCustomController } from 'src/features/gateway/financialrecords/custom.controller';
import { FinancialrecordsModule } from 'src/features/gateway/financialrecords/module';
import { splitEntity } from 'src/features/gateway/splits/rules.crud';
import { studentEntity } from 'src/features/student/student/rules.crud';
import { StudentCustomController } from 'src/features/student/student/custom.controller';
import { StudentModule } from 'src/features/student/student/module';
import { studentCoursesEntity } from 'src/features/student/student-courses/rules.crud';
import { StudentCoursesCustomController } from 'src/features/student/student-courses/custom.controller';
import { StudentCoursesModule } from 'src/features/student/student-courses/module';
import { studentCertificatesEntity } from 'src/features/student/student-certificates/rules.crud';
import { StudentCertificatesCustomController } from 'src/features/student/student-certificates/custom.controller';
import { StudentCertificatesModule } from 'src/features/student/student-certificates/module';
import { CrudEntity, multipart } from './crud.module';

const upload = (folder: string) => multipart(UseInterceptors(FileInterceptor('image', getMulterOptions(folder))));
const uploadOptimized = multipart(UseInterceptors(FileInterceptor('image', getOptimizedMulterOptions())));
const uploadBranding = multipart(UseInterceptors(
  FileFieldsInterceptor([{ name: 'logo', maxCount: 1 }, { name: 'favicon', maxCount: 1 }], getOptimizedMulterOptions()),
  ImageOptimizationInterceptor,
));
const uploadCover = multipart(UseInterceptors(FileInterceptor('image', getOptimizedMulterOptions()), ImageOptimizationInterceptor));
const evict = (prefix: string, route: string) => CacheEvictAll(`${prefix}:*`, `cache:*/${route}*`);
const evictSiteServices = evict('site-services', 'site-services');
const evictSiteTaxonomy = (route: string) =>
  CacheEvictAll('site-products:*', 'cache:*/site-products*', `cache:*/${route}*`);
const blogEvict = (name: string) =>
  CacheEvictAll(`blog/${name}:*`, `blog-${name}-public:*`, `cache:*/blog/${name}*`, `cache:*/blog-${name}-public*`);
const postEvict = CacheEvictAll(
  'blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*',
  'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*',
);
const classesEvict = CacheEvictAll('training-classes:*', 'cache:*/classes*');
const subsEvict = CacheEvictAll('subscription:*', 'cache:*/subscription*', 'training-classes:*', 'cache:*/classes*');
const coursesEvict = CacheEvictAll('training-classes:*', 'cache:*/classes*', 'list-courses');
const productImgEvict = CacheEvictAll('site-productsimages:*', 'site-products:*', 'cache:*/site-products*');
const writeOps = (decos: MethodDecorator[]) => ({ create: decos, update: decos, archive: decos, restore: decos });
const blogCrud = (rules: CrudEntity['rules'], name: string): CrudEntity => ({
  rules,
  controller: {
    prefix: 'blog',
    decorators: {
      list: [Cache({ prefix: `blog/${name}`, ttl: 3600 })],
      listPublic: [Cache({ prefix: `blog-${name}-public`, ttl: 3600 })],
      create: [blogEvict(name)], update: [blogEvict(name)],
      archive: [blogEvict(name)], restore: [blogEvict(name)],
    },
  },
});

export const crudEntities: CrudEntity[] = [
  { rules: userEntity, controller: { decorators: {
    create: [upload('user-profile')], update: [upload('user-profile')], updateSelf: [upload('user-profile')] } } },
  { rules: customerEntity, controller: { decorators: {
    create: [upload('custumer-logo')], update: [upload('custumer-logo')] } } },
  { rules: profileEntity, controller: { decorators: { create: [upload('profile-image')], update: [upload('profile-image')] } } },
  { rules: customerContactsEntity, controller: { decorators: {
    create: [upload('customer_contacts-image')], update: [upload('customer_contacts-image')] } } },
  { rules: imageEntity, controller: { decorators: { create: [upload('image-image')] } } },
  { rules: companyEntity, controller: { decorators: {
    listPublic: [Cache({ prefix: 'companies', ttl: 172800 })],
    update: [uploadBranding, evict('companies', 'companies')],
  } } },
  { rules: ranksEntity },
  { rules: rolesEntity },
  { rules: statesEntity },
  { rules: citiesEntity },
  { rules: siteServicesEntity, controller: { decorators: {
    list: [Cache({ prefix: 'site-services', ttl: 172800 })],
    create: [upload('services-image'), evictSiteServices],
    update: [upload('services-image'), evictSiteServices],
    archive: [evictSiteServices], restore: [evictSiteServices],
  } } },
  { rules: siteProductsEntity, controller: { decorators: {
    list: [Cache({ prefix: 'site-products', ttl: 172800 })],
    create: [upload('site_products-image'), evict('site-products', 'site-products')],
    update: [upload('site_products-image'), evict('site-products', 'site-products')],
    archive: [evict('site-products', 'site-products')], restore: [evict('site-products', 'site-products')],
  } } },
  // categoria/marca aparecem dentro da lista de produtos (cache de 48h):
  // mudar uma delas limpa também o cache dos produtos
  ...[siteProductCategoryEntity, siteProductBrandEntity].map((rules) => ({ rules, controller: { decorators: {
    create: [evictSiteTaxonomy(rules.entity)], update: [evictSiteTaxonomy(rules.entity)],
    archive: [evictSiteTaxonomy(rules.entity)], restore: [evictSiteTaxonomy(rules.entity)],
  } } })),
  { rules: instructorEntity, controller: { decorators: { create: [uploadOptimized], update: [uploadOptimized] } } },
  { rules: couponEntity, controller: { decorators: {
    create: [evict('coupon', 'coupon')], update: [evict('coupon', 'coupon')],
    archive: [evict('coupon', 'coupon')], restore: [evict('coupon', 'coupon')],
  } } },
  blogCrud(blogTagEntity, 'tags'),
  blogCrud(blogCategoryEntity, 'categories'),
  { rules: blogPostEntity, controller: { prefix: 'blog', decorators: {
    list: [Cache({ prefix: 'blog/posts', ttl: 1800 })],
    listPublic: [Cache({ prefix: 'blog-posts-public', ttl: 1800 })],
    create: [uploadCover, postEvict], update: [uploadCover, postEvict],
    archive: [postEvict], restore: [postEvict],
  } } },
  { rules: blogCommentEntity, controller: { prefix: 'blog' } },
  { rules: siteProductImagesEntity, controller: { decorators: {
    ...writeOps([productImgEvict]), create: [upload('site_productsimages-image'), productImgEvict], update: [upload('site_productsimages-image'), productImgEvict] } } },
  { rules: classInstructorEntity, controller: { decorators: writeOps([subsEvict]) } },
  { rules: reviewEntity, controller: { decorators: { archive: [classesEvict], restore: [classesEvict] } } },
  { rules: courseEntity, controller: { decorators: {
    ...writeOps([coursesEvict]), create: [upload('course-image'), coursesEvict], update: [upload('course-image'), coursesEvict] } } },
  { rules: traineeEntity },
  { rules: examEntity },
  { rules: certificateTemplateEntity },
  { rules: attendanceEntity },
  { rules: onlineCourseModelEntity },
  { rules: onlineLessonEntity },
  { rules: onlineLessonStepEntity },
  { rules: onlineModelLessonEntity },
  { rules: companyGatewayEntity, controller: { decorators: {
    list: [Cache({ prefix: 'company-gateway', ttl: 604800 })],
    ...writeOps([evict('company-gateway', 'company-gateway')]) } } },
  { rules: financialRecordEntity },
  { rules: splitEntity },
  // ---- aluno: guard do aluno em toda op; escopo = traineeId do token ----
  { rules: studentEntity, controller: { decorators: { list: [studentGuard], getById: [studentGuard], update: [studentGuard, upload('student-image')] } } },
  { rules: studentCoursesEntity, controller: { decorators: { list: [studentGuard], getById: [studentGuard], create: [studentGuard], update: [studentGuard] } } },
  { rules: studentCertificatesEntity, controller: { decorators: { list: [studentGuard], getById: [studentGuard] } } },
  { rules: classEntity, controller: { decorators: {
    list: [Cache({ prefix: 'training-classes', ttl: 172800 })],
    create: [uploadCover, classesEvict], update: [uploadCover, classesEvict], archive: [classesEvict], restore: [classesEvict] } } },
  { rules: subscriptionEntity, controller: { decorators: writeOps([subsEvict]) } },
  { rules: traineeCertificateEntity, controller: { decorators: {
    listPublic: [Throttle({ default: { limit: 500, ttl: 60000 } })],
    create: [upload('trainee_certificate-image')], update: [upload('trainee_certificate-image')] } } },
  { rules: blogVisitorEntity, controller: { prefix: 'blog' } },
];

/** Rotas custom que reusam o CrudService (fora da fábrica, explícitas). */
export const crudExtraControllers = [
  InstructorSignatureController,
  ImageCustomController,
  CompanyCustomController,
  ReviewsCustomController,
  CourseCustomController,
  ExamesCustomController,
  AttendanceCustomController,
  OnlineModelLessonCustomController,
  ClassesCustomController,
  SubscriptionCustomController,
  TraineeCertificateCustomController,
  FinancialRecordsCustomController,
  StudentCustomController,
  StudentCoursesCustomController,
  StudentCertificatesCustomController,
  PostCustomController,
  CommentCustomController,
  VisitorCustomController,
];

/** Módulos que os controllers custom precisam (services de domínio, IA). */
export const crudExtraImports = [PostModule, CommentModule, AIModule, UploadModule, ImageModule, CompanyModule, ReviewsModule, CourseModule, ExamesModule, ClassesModule, SubscriptionModule, TraineeCertificateModule, StudentModule, StudentCoursesModule, StudentCertificatesModule, FinancialrecordsModule];
