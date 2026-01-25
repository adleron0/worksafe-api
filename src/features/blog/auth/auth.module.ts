import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { BlogAuthController } from './auth.controller';
import { BlogAuthService } from './auth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { VisitorAuthGuard } from './guards/visitor-auth.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'google-blog' }),
    JwtModule.register({
      secret: process.env.JWT_VISITOR_SECRET || process.env.JWT_SECRET,
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [BlogAuthController],
  providers: [BlogAuthService, GoogleStrategy, VisitorAuthGuard],
  exports: [BlogAuthService, VisitorAuthGuard, JwtModule],
})
export class BlogAuthModule {}
