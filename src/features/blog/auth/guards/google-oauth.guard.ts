import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google-blog') {
  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    // Extrai parâmetros da query
    const { companyId, domain, redirectUrl } = request.query;

    // Monta o state com os dados necessários
    const state = Buffer.from(
      JSON.stringify({ companyId, domain, redirectUrl }),
    ).toString('base64');

    return {
      state,
      scope: ['email', 'profile'],
    };
  }
}
