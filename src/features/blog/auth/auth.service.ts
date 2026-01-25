import { Injectable, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';

interface GoogleUserData {
  googleId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  companyId: number;
}

@Injectable()
export class BlogAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  /**
   * Busca ou cria visitante a partir dos dados do Google
   */
  async findOrCreateVisitor(googleData: GoogleUserData) {
    const { googleId, name, email, avatarUrl, companyId } = googleData;

    if (!companyId) {
      throw new BadRequestException('companyId é obrigatório');
    }

    // Busca visitante existente pelo googleId
    let visitor = await this.prisma.blog_Visitor.findFirst({
      where: {
        companyId: Number(companyId),
        googleId,
      },
    });

    if (!visitor) {
      // Verifica se é um usuário interno pelo email
      const internalUser = await this.prisma.user.findFirst({
        where: {
          companyId: Number(companyId),
          email,
        },
      });

      // Cria novo visitante
      visitor = await this.prisma.blog_Visitor.create({
        data: {
          companyId: Number(companyId),
          googleId,
          name,
          email,
          avatarUrl,
          userId: internalUser?.id || null,
          blocked: false,
        },
      });
    } else {
      // Atualiza dados do visitante (nome e avatar podem mudar)
      visitor = await this.prisma.blog_Visitor.update({
        where: { id: visitor.id },
        data: {
          name,
          avatarUrl,
        },
      });
    }

    return visitor;
  }

  /**
   * Gera token JWT para o visitante
   */
  generateVisitorToken(visitor: any) {
    const payload = {
      sub: visitor.id,
      type: 'visitor',
      companyId: visitor.companyId,
      googleId: visitor.googleId,
      name: visitor.name,
      email: visitor.email,
    };

    return this.jwtService.sign(payload, {
      secret: process.env.JWT_VISITOR_SECRET || process.env.JWT_ACCESS_SECRET,
      expiresIn: '7d',
    });
  }

  /**
   * Busca visitante por ID
   */
  async getVisitorById(id: number) {
    return this.prisma.blog_Visitor.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, imageUrl: true },
        },
      },
    });
  }

  /**
   * Verifica se visitante está bloqueado
   */
  async isVisitorBlocked(visitorId: number): Promise<boolean> {
    const visitor = await this.prisma.blog_Visitor.findUnique({
      where: { id: visitorId },
      select: { blocked: true },
    });
    return visitor?.blocked || false;
  }

  /**
   * Busca empresa por domínio
   */
  async findCompanyByDomain(domain: string) {
    return this.prisma.company.findFirst({
      where: { lp_domain: domain },
      select: { id: true },
    });
  }
}
