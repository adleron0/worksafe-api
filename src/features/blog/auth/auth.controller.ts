import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { BlogAuthService } from './auth.service';
import { VisitorAuthGuard } from './guards/visitor-auth.guard';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';

@Controller('blog/auth')
export class BlogAuthController {
  constructor(private readonly authService: BlogAuthService) {}

  /**
   * Inicia o fluxo OAuth com Google
   * Recebe companyId ou domain e redirectUrl como query params
   */
  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  async googleAuth() {
    // O guard GoogleOAuthGuard monta o state e redireciona para o Google
    // Este método não é executado pois o guard faz o redirect
  }

  /**
   * Callback do Google OAuth
   */
  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google-blog'))
  async googleAuthCallback(@Req() req: any, @Res() res: Response) {
    // Extrai dados do state primeiro para ter o redirectUrl em caso de erro
    let redirectUrl = process.env.BLOG_DEFAULT_REDIRECT || 'http://localhost:3030';
    let companyId = null;
    let domain = null;

    const state = req.query.state;
    console.log('🔍 OAuth Callback - state:', state);

    if (state) {
      try {
        const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
        console.log('🔍 OAuth Callback - stateData:', stateData);
        redirectUrl = stateData.redirectUrl || redirectUrl;
        companyId = stateData.companyId;
        domain = stateData.domain;
      } catch (e) {
        console.error('❌ Erro ao parsear state:', e);
      }
    }

    try {
      const googleUser = req.user;
      console.log('🔍 OAuth Callback - googleUser:', googleUser);

      // Usa companyId do state ou do googleUser
      companyId = companyId || googleUser?.companyId;

      // Se não tem companyId mas tem domain, busca o companyId
      if (!companyId && domain) {
        const company = await this.authService.findCompanyByDomain(domain);
        console.log('🔍 OAuth Callback - company by domain:', company);
        if (company) {
          companyId = company.id;
        }
      }

      if (!companyId) {
        console.error('❌ companyId não encontrado');
        const separator = redirectUrl.includes('?') ? '&' : '?';
        return res.redirect(`${redirectUrl}${separator}error=missing_company_id`);
      }

      // Busca ou cria o visitante
      const visitor = await this.authService.findOrCreateVisitor({
        ...googleUser,
        companyId: Number(companyId),
      });
      console.log('✅ Visitor:', visitor.id, visitor.name);

      // Verifica se está bloqueado
      if (visitor.blocked) {
        const separator = redirectUrl.includes('?') ? '&' : '?';
        return res.redirect(`${redirectUrl}${separator}error=visitor_blocked`);
      }

      // Gera token JWT
      const token = this.authService.generateVisitorToken(visitor);

      // Redireciona com o token
      const separator = redirectUrl.includes('?') ? '&' : '?';
      console.log('✅ Redirecionando para:', `${redirectUrl}${separator}token=...`);
      return res.redirect(`${redirectUrl}${separator}token=${token}`);
    } catch (error) {
      console.error('❌ Erro no callback do Google:', error);
      const separator = redirectUrl.includes('?') ? '&' : '?';
      return res.redirect(`${redirectUrl}${separator}error=auth_failed`);
    }
  }

  /**
   * Retorna dados do visitante logado
   */
  @Public()
  @Get('me')
  @UseGuards(VisitorAuthGuard)
  async getMe(@Req() req: any) {
    const visitor = await this.authService.getVisitorById(req.visitor.sub);

    if (!visitor) {
      throw new UnauthorizedException('Visitante não encontrado');
    }

    if (visitor.blocked) {
      throw new UnauthorizedException('Visitante bloqueado');
    }

    return visitor;
  }
}
