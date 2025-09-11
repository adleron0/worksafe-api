import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StudentAuthService } from './student-auth.service';
import { PasswordCodeService } from './password-code.service';
import { StudentLoginDto } from './dtos/student-auth.dto';
import {
  RequestCodeDto,
  VerifyCodeDto,
  SetPasswordDto,
  ResendCodeDto,
} from './dtos/password-code.dto';
import { Public } from './decorators/public.decorator';
import { StudentAuth } from './decorators/student-auth.decorator';
import { Request } from 'express';

@Controller('auth/student')
export class StudentAuthController {
  constructor(
    private readonly studentAuthService: StudentAuthService,
    private readonly passwordCodeService: PasswordCodeService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: StudentLoginDto) {
    return this.studentAuthService.loginStudent(dto.credential, dto.password);
  }

  @StudentAuth()
  @Get('me')
  async getProfile(@Req() req: Request) {
    const traineeId = req['traineeId'];
    return this.studentAuthService.getTraineeProfile(traineeId);
  }

  @StudentAuth()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout() {
    // Como não temos refresh token, apenas retornamos sucesso
    // O cliente deve remover o token do localStorage/sessionStorage
    return { message: 'Logout realizado com sucesso' };
  }

  // Endpoints para primeiro acesso e recuperação de senha

  @Public()
  @Post('request-code')
  @HttpCode(HttpStatus.OK)
  async requestCode(@Body() dto: RequestCodeDto) {
    return this.passwordCodeService.requestCode(dto.credential, dto.type);
  }

  @Public()
  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  async verifyCode(@Body() dto: VerifyCodeDto) {
    return this.passwordCodeService.verifyCode(dto.credential, dto.code);
  }

  @Public()
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  async setPassword(@Body() dto: SetPasswordDto) {
    return this.passwordCodeService.setPassword(
      dto.credential,
      dto.code,
      dto.newPassword,
    );
  }

  @Public()
  @Post('resend-code')
  @HttpCode(HttpStatus.OK)
  async resendCode(@Body() dto: ResendCodeDto) {
    return this.passwordCodeService.resendCode(dto.credential);
  }

  // Endpoint administrativo para limpar códigos expirados (opcional)
  @StudentAuth()
  @Post('clean-expired-codes')
  @HttpCode(HttpStatus.OK)
  async cleanExpiredCodes() {
    return this.passwordCodeService.cleanExpiredCodes();
  }
}
