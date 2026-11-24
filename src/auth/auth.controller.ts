import { Throttle } from '@nestjs/throttler';
import { LoginAttemptsService } from 'src/common/security/login-attempts.service';
import { clientIpOf } from 'src/common/security/client-ip';
import {
  Controller,
  Post,
  Body,
  Res,
  UnauthorizedException,
  NotAcceptableException,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { Request, Response } from 'express';
import { LoginDto } from './dtos/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly loginAttempts: LoginAttemptsService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // tentativa de senha: 10/min por IP
  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async login(
    @Body() user: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const ip = clientIpOf(request);
    const account = `${user.email ?? ''}|${(user as any).cnpj ?? ''}`;
    await this.loginAttempts.assertAllowed('user', ip, account);
    try {
      const result = await this.authService.login(user, response);
      await this.loginAttempts.registerSuccess('user', ip, account);
      return result;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        await this.loginAttempts.registerFailure('user', ip, account);
      }
      throw e;
    }
  }

  @Public()
  @Post('refresh-token')
  async refreshToken(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = request.cookies['refreshToken'];
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token found');
    }
    const secretWord = request.body.secretWord;
    if (secretWord) {
      await this.authService.logout(refreshToken, response);
      throw new NotAcceptableException('Direcionado para Logout');
    } else {
      const result = await this.authService.refreshToken(refreshToken);
      return result;
    }
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = request.cookies['refreshToken'];
    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token found');
    }
    await this.authService.logout(refreshToken, response);
    return { message: 'Logout successful' };
  }
}
