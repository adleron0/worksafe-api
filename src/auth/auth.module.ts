import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { StudentAuthService } from './student-auth.service';
import { StudentAuthController } from './student-auth.controller';
import { PasswordCodeService } from './password-code.service';
import { UserModule } from '../features/users/user/module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../features/email/email.module';
import { JwtModule } from '@nestjs/jwt';
import { env } from 'process';
import { GoogleOidcService } from './google/google-oidc.service';
import { GoogleAuthService } from './google/google-auth.service';
import { GoogleAuthController } from './google/google-auth.controller';
import { AccessAdminService } from './google/access-admin.service';
import { AccessRequestController } from './google/access-request.controller';
import {
  AccessRequestsAdminController,
  AccessSettingsController,
  ExternalInvitesController,
} from './google/access-admin.controller';
import { PendingAuthGuard } from './google/pending.guard';

@Module({
  imports: [
    UserModule,
    PrismaModule,
    EmailModule,
    JwtModule.register({
      global: true,
      secret: env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: '60s' },
    }),
  ],
  providers: [
    AuthService,
    StudentAuthService,
    PasswordCodeService,
    GoogleOidcService,
    GoogleAuthService,
    AccessAdminService,
    PendingAuthGuard,
  ],
  controllers: [
    AuthController,
    StudentAuthController,
    GoogleAuthController,
    AccessRequestController,
    AccessRequestsAdminController,
    ExternalInvitesController,
    AccessSettingsController,
  ],
  exports: [AuthService, StudentAuthService, PasswordCodeService],
})
export class AuthModule {}
