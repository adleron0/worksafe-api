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
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async login(
    @Body() user: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(user, response);
    return result;
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
