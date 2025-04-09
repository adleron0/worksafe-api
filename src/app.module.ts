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
