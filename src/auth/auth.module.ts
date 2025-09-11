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
  providers: [AuthService, StudentAuthService, PasswordCodeService],
  controllers: [AuthController, StudentAuthController],
  exports: [AuthService, StudentAuthService, PasswordCodeService],
})
export class AuthModule {}
