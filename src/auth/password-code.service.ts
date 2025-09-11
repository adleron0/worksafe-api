import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/features/email/email.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class PasswordCodeService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {
    // Inicializa o EmailService com as configurações
    this.initializeEmailService();
  }

  private initializeEmailService() {
    // Verifica se já está inicializado
    if (this.emailService.isInitialized()) {
      return;
    }

    // Configurações do email (você pode colocar no .env)
    const emailConfig = {
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587', 10),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASSWORD || '',
      },
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || '',
    };

    // Valida se as configurações estão presentes
    if (!emailConfig.host || !emailConfig.auth.user || !emailConfig.auth.pass) {
      console.warn(
        'Email service not configured. Please set EMAIL_HOST, EMAIL_USER, and EMAIL_PASSWORD in .env',
      );
      return;
    }

    this.emailService.initialize(emailConfig);
  }

  // Gera código aleatório de 6 dígitos
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Solicita código para primeiro acesso ou recuperação
  async requestCode(credential: string, type: 'first_access' | 'reset') {
    console.log(
      '🚀 ~ PasswordCodeService ~ requestCode ~ credential:',
      credential,
    );
    // Busca o trainee por email ou CPF
    const trainee = await this.prisma.trainee.findFirst({
      where: {
        OR: [{ email: credential }, { cpf: credential }],
        active: true,
      },
      // select: {
      //   id: true,
      //   name: true,
      //   email: true,
      //   password: true,
      // },
    });
    console.log('🚀 ~ PasswordCodeService ~ requestCode ~ trainee:', trainee);

    if (!trainee) {
      // Não revela se o usuário existe (segurança)
      return {
        message:
          'Se o email/CPF estiver cadastrado, você receberá um código de verificação.',
      };
    }

    if (!trainee.email) {
      throw new BadRequestException('Email não cadastrado para este aluno');
    }

    // Verifica o tipo de solicitação
    if (type === 'first_access' && trainee.password) {
      throw new BadRequestException(
        'Senha já foi definida. Use a opção de recuperação de senha.',
      );
    }

    if (type === 'reset' && !trainee.password) {
      throw new BadRequestException(
        'Você ainda não definiu uma senha. Use a opção de primeiro acesso.',
      );
    }

    // Invalida códigos anteriores não usados
    await this.prisma.passwordCode.updateMany({
      where: {
        entityType: 'trainee',
        entityId: trainee.id,
        used: false,
      },
      data: {
        used: true,
      },
    });

    // Gera novo código
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Salva o código no banco
    await this.prisma.passwordCode.create({
      data: {
        entityType: 'trainee',
        entityId: trainee.id,
        email: trainee.email,
        code,
        type,
        expiresAt,
      },
    });

    // Envia email com o código
    await this.sendCodeEmail(trainee.email, trainee.name, code, type);

    return {
      message: 'Código enviado para o email cadastrado',
      email: this.maskEmail(trainee.email),
    };
  }

  // Verifica se o código é válido
  async verifyCode(credential: string, code: string) {
    // Busca o trainee
    const trainee = await this.prisma.trainee.findFirst({
      where: {
        OR: [{ email: credential }, { cpf: credential }],
        active: true,
      },
      select: {
        id: true,
        email: true,
      },
    });

    if (!trainee || !trainee.email) {
      throw new UnauthorizedException('Código inválido ou expirado');
    }

    // Busca o código
    const passwordCode = await this.prisma.passwordCode.findFirst({
      where: {
        entityType: 'trainee',
        entityId: trainee.id,
        code,
        used: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!passwordCode) {
      throw new UnauthorizedException('Código inválido ou expirado');
    }

    return {
      valid: true,
      type: passwordCode.type,
      message: 'Código válido. Agora você pode definir sua nova senha.',
    };
  }

  // Define/redefine a senha usando o código
  async setPassword(credential: string, code: string, newPassword: string) {
    // Busca o trainee
    const trainee = await this.prisma.trainee.findFirst({
      where: {
        OR: [{ email: credential }, { cpf: credential }],
        active: true,
      },
      select: {
        id: true,
        email: true,
      },
    });

    if (!trainee || !trainee.email) {
      throw new UnauthorizedException('Código inválido ou expirado');
    }

    // Busca e valida o código
    const passwordCode = await this.prisma.passwordCode.findFirst({
      where: {
        entityType: 'trainee',
        entityId: trainee.id,
        code,
        used: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!passwordCode) {
      throw new UnauthorizedException('Código inválido ou expirado');
    }

    // Hash da nova senha
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Atualiza a senha do trainee
    await this.prisma.trainee.update({
      where: { id: trainee.id },
      data: { password: hashedPassword },
    });

    // Marca o código como usado
    await this.prisma.passwordCode.update({
      where: { id: passwordCode.id },
      data: { used: true },
    });

    return {
      success: true,
      message:
        passwordCode.type === 'first_access'
          ? 'Senha criada com sucesso! Agora você pode fazer login.'
          : 'Senha redefinida com sucesso!',
    };
  }

  // Reenvia o código (invalida o anterior)
  async resendCode(credential: string) {
    console.log(
      '🚀 ~ PasswordCodeService ~ resendCode ~ credential:',
      credential,
    );
    // Busca o trainee
    const trainee = await this.prisma.trainee.findFirst({
      where: {
        OR: [{ email: credential }, { cpf: credential }],
        active: true,
      },
      select: {
        id: true,
        email: true,
        password: true,
      },
    });
    console.log('🚀 ~ PasswordCodeService ~ resendCode ~ trainee:', trainee);

    if (!trainee || !trainee.email) {
      return {
        message:
          'Se o email/CPF estiver cadastrado, você receberá um novo código.',
      };
    }

    // Busca o último código não usado
    const lastCode = await this.prisma.passwordCode.findFirst({
      where: {
        entityType: 'trainee',
        entityId: trainee.id,
        used: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!lastCode) {
      throw new BadRequestException(
        'Nenhuma solicitação de código encontrada. Faça uma nova solicitação.',
      );
    }

    // Verifica limite de reenvio (máximo 1 a cada 2 minutos)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    if (lastCode.createdAt > twoMinutesAgo) {
      const waitTime = Math.ceil(
        (lastCode.createdAt.getTime() + 2 * 60 * 1000 - Date.now()) / 1000,
      );
      throw new BadRequestException(
        `Aguarde ${waitTime} segundos antes de solicitar um novo código.`,
      );
    }

    // Determina o tipo baseado na presença de senha
    const type = trainee.password ? 'reset' : 'first_access';

    // Solicita novo código
    return this.requestCode(credential, type);
  }

  // Envia email com o código
  private async sendCodeEmail(
    email: string,
    name: string,
    code: string,
    type: 'first_access' | 'reset',
  ) {
    const subject =
      type === 'first_access'
        ? 'Seu código de primeiro acesso - WorkSafe'
        : 'Seu código de recuperação de senha - WorkSafe';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Olá ${name},</h2>
        
        <p style="font-size: 16px; color: #666;">
          ${
            type === 'first_access'
              ? 'Bem-vindo ao WorkSafe! Use o código abaixo para criar sua senha de acesso:'
              : 'Você solicitou a recuperação de sua senha. Use o código abaixo para criar uma nova senha:'
          }
        </p>
        
        <div style="background-color: #f0f0f0; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
          <h1 style="color: #333; letter-spacing: 5px; margin: 0;">${code}</h1>
        </div>
        
        <p style="font-size: 14px; color: #999;">
          Este código é válido por 15 minutos. Se você não solicitou este código, ignore este email.
        </p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #999; text-align: center;">
          WorkSafe Brasil - Sistema de Gestão de Treinamentos
        </p>
      </div>
    `;

    try {
      await this.emailService.sendEmail({
        to: email,
        subject,
        html,
      });
    } catch (error) {
      console.error('Erro ao enviar email:', error);
      throw new BadRequestException('Erro ao enviar email com o código');
    }
  }

  // Mascara o email para privacidade
  private maskEmail(email: string): string {
    const [user, domain] = email.split('@');
    const maskedUser = user.substring(0, 2) + '***';
    return `${maskedUser}@${domain}`;
  }

  // Limpa códigos expirados (pode ser chamado manualmente ou via cron)
  async cleanExpiredCodes() {
    const result = await this.prisma.passwordCode.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    return {
      deleted: result.count,
      message: `${result.count} códigos expirados foram removidos`,
    };
  }
}
