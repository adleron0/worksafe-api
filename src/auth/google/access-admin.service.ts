import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { EmailService } from 'src/features/email/email.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { extractUserPermissions } from '../utils/check-permission.util';
import { emailIsFromDomain } from '../auth.service';
import { GoogleOidcService } from './google-oidc.service';
import { frontUrl } from './google-auth.controller';

export interface Requester {
  sub: number;
  companyId: number;
  profile?: string;
  permissions?: unknown;
}

const MAX_INVITE_DAYS = 180;
const WARN_DAYS = 5;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const clean = (v: unknown, max = 500) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

/**
 * Pedidos de perfil (quem entrou com o Google do domínio), convites de gente de
 * fora e a configuração do Google da empresa.
 */
@Injectable()
export class AccessAdminService {
  private readonly logger = new Logger('AccessAdmin');

  constructor(
    private readonly prisma: PrismaService,
    private readonly authCache: AuthCacheService,
    private readonly email: EmailService,
    private readonly oidc: GoogleOidcService,
  ) {}

  // ------------------------------------------------------------ tela do pendente

  async myRequest(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, imageUrl: true, profileId: true, active: true },
    });
    if (!user || !user.active) throw new ForbiddenException('Acesso negado para este usuário!');
    const request = await this.prisma.accessRequest.findFirst({
      where: { userId },
      orderBy: { id: 'desc' },
      select: { status: true, message: true, reason: true, createdAt: true, decidedAt: true },
    });
    return {
      user: { name: user.name, email: user.email, imageUrl: user.imageUrl },
      request,
      approved: Boolean(user.profileId),
    };
  }

  async createRequest(userId: number, message?: unknown) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.inactiveAt || !user.companyId) {
      throw new ForbiddenException('Acesso negado para este usuário!');
    }
    if (user.externalUntil) throw new ForbiddenException('Convidado não pede perfil.');
    if (user.profileId) throw new ConflictException('Seu acesso já foi liberado.');
    const open = await this.prisma.accessRequest.findFirst({ where: { userId, status: 'pending' } });
    if (open) return { id: open.id, status: open.status, createdAt: open.createdAt };

    const created = await this.prisma.accessRequest.create({
      data: { companyId: user.companyId, userId, message: clean(message) },
    });
    void this.notifyApprovers(user.companyId, user.name, user.email, created.message).catch((e) =>
      this.logger.warn(`aviso do pedido de acesso não saiu: ${(e as Error).message}`),
    );
    return { id: created.id, status: created.status, createdAt: created.createdAt };
  }

  // ------------------------------------------------------------- quem aprova

  async listRequests(companyId: number, status?: string) {
    const where: any = { companyId };
    if (status && ['pending', 'approved', 'rejected'].includes(status)) where.status = status;
    const rows = await this.prisma.accessRequest.findMany({
      where,
      orderBy: [{ status: 'desc' }, { id: 'desc' }],
      take: 200,
      include: {
        user: { select: { id: true, name: true, email: true, imageUrl: true, active: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });
    const profileIds = [...new Set(rows.map((r) => r.profileId).filter(Boolean))] as number[];
    const profiles = profileIds.length
      ? await this.prisma.profile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true } })
      : [];
    const pname = new Map(profiles.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ ...r, profileName: r.profileId ? pname.get(r.profileId) ?? null : null }));
  }

  async countPending(companyId: number) {
    return { pending: await this.prisma.accessRequest.count({ where: { companyId, status: 'pending' } }) };
  }

  async approve(requester: Requester, id: number, profileId: number) {
    const req = await this.prisma.accessRequest.findFirst({
      where: { id, companyId: requester.companyId },
      include: { user: true },
    });
    if (!req) throw new NotFoundException('Pedido não encontrado');
    if (req.status !== 'pending') throw new ConflictException('Este pedido já foi decidido.');
    if (!req.user.active || req.user.inactiveAt) throw new BadRequestException('Usuário inativo.');
    const profile = await this.assertGrantableProfile(requester, profileId);

    await this.prisma.$transaction(async (tx) => {
      // só decide quem chegar primeiro: dois aprovadores ao mesmo tempo, vale um
      const { count } = await tx.accessRequest.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'approved', profileId: profile.id, decidedById: requester.sub, decidedAt: new Date() },
      });
      if (count !== 1) throw new ConflictException('Este pedido já foi decidido.');
      await tx.user.update({ where: { id: req.userId }, data: { profileId: profile.id } });
      await tx.system_Logs.create({
        data: {
          companyId: requester.companyId, userId: requester.sub, action: 'aprovar_acesso', entity: 'user',
          entityId: req.userId, column: 'profileId', oldValue: null, newValue: String(profile.id),
        },
      });
    });
    await this.authCache.invalidateUserCache(req.userId);
    return { ok: true };
  }

  async reject(requester: Requester, id: number, reason?: unknown) {
    const req = await this.prisma.accessRequest.findFirst({ where: { id, companyId: requester.companyId } });
    if (!req) throw new NotFoundException('Pedido não encontrado');
    if (req.status !== 'pending') throw new ConflictException('Este pedido já foi decidido.');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.accessRequest.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'rejected', reason: clean(reason), decidedById: requester.sub, decidedAt: new Date() },
      });
      if (count !== 1) throw new ConflictException('Este pedido já foi decidido.');
      await tx.system_Logs.create({
        data: {
          companyId: requester.companyId, userId: requester.sub, action: 'recusar_acesso', entity: 'user',
          entityId: req.userId, column: null, oldValue: null, newValue: null,
        },
      });
    });
    return { ok: true };
  }

  /**
   * Perfil que esse requester pode dar: da empresa, ativo, nunca "super" e,
   * para quem não é super, só com permissões que ele mesmo tem.
   */
  async assertGrantableProfile(requester: Requester, profileId: number) {
    if (!Number.isInteger(profileId) || profileId <= 0) throw new BadRequestException('Escolha o perfil.');
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, companyId: requester.companyId, inactiveAt: null },
      include: { permissions: { where: { inactiveAt: null }, include: { permission: true } } },
    });
    if (!profile) throw new BadRequestException('Perfil não encontrado.');
    if (profile.name === 'super') throw new ForbiddenException('O perfil super não pode ser dado por aqui.');
    if (requester.profile !== 'super') {
      const mine = new Set(extractUserPermissions(requester));
      const missing = profile.permissions.filter((pp) => !mine.has(pp.permission.name));
      if (missing.length) {
        throw new ForbiddenException(
          `Você não pode dar um perfil com permissões que não tem: ${missing
            .slice(0, 5)
            .map((pp) => pp.permission.description || pp.permission.name)
            .join(', ')}${missing.length > 5 ? '…' : ''}`,
        );
      }
    }
    return profile;
  }

  // ------------------------------------------------------------------ convites

  async listInvites(companyId: number) {
    const rows = await this.prisma.externalInvite.findMany({
      where: { companyId },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { expiresAt: 'desc' }],
      include: {
        invitedBy: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, imageUrl: true, active: true } },
      },
    });
    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.profileId))] } },
      select: { id: true, name: true },
    });
    const pname = new Map(profiles.map((p) => [p.id, p.name]));
    const now = Date.now();
    return rows.map(({ googleSub, ...r }) => ({
      ...r,
      linked: Boolean(googleSub),
      profileName: pname.get(r.profileId) ?? null,
      situation: r.revokedAt ? 'revoked' : r.expiresAt.getTime() <= now ? 'expired' : 'active',
    }));
  }

  private daysFrom(days: unknown) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_INVITE_DAYS) {
      throw new BadRequestException(`Prazo entre 1 e ${MAX_INVITE_DAYS} dias.`);
    }
    return new Date(Date.now() + n * 86400000);
  }

  async createInvite(requester: Requester, body: { email?: unknown; profileId?: unknown; days?: unknown; reason?: unknown }) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 255) throw new BadRequestException('E-mail inválido.');
    const company = await this.prisma.company.findUnique({ where: { id: requester.companyId } });
    if (emailIsFromDomain(email, company?.google_domain)) {
      throw new BadRequestException('E-mail da empresa não precisa de convite: entra direto com o Google.');
    }
    const profile = await this.assertGrantableProfile(requester, Number(body?.profileId));
    const expiresAt = this.daysFrom(body?.days);
    const reason = clean(body?.reason);

    const existing = await this.prisma.externalInvite.findUnique({
      where: { companyId_email: { companyId: requester.companyId, email } },
    });
    // convite só cria gente nova: quem já tem usuário com esse e-mail é tratado
    // na tela de usuários (não vira convidado nem herda prazo por aqui)
    const sameEmail = await this.prisma.user.findFirst({
      where: { companyId: requester.companyId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (sameEmail && sameEmail.id !== existing?.userId) {
      throw new ConflictException('Já existe um usuário com este e-mail. Ajuste o acesso dele na tela de usuários.');
    }
    if (existing && !existing.revokedAt && existing.expiresAt > new Date()) {
      throw new ConflictException('Já existe um convite ativo para este e-mail.');
    }
    // reaproveitar um convite vencido/revogado mantém o vínculo com a mesma conta Google
    const invite = existing
      ? await this.prisma.externalInvite.update({
          where: { id: existing.id },
          data: { profileId: profile.id, expiresAt, reason, invitedById: requester.sub, revokedAt: null, warnedAt: null },
        })
      : await this.prisma.externalInvite.create({
          data: { companyId: requester.companyId, email, profileId: profile.id, expiresAt, reason, invitedById: requester.sub },
        });
    if (invite.userId) {
      await this.assertNotSuperTarget(requester, invite.userId);
      await this.syncInvitedUser(invite.userId, { profileId: profile.id, externalUntil: expiresAt, reactivate: true });
    }
    await this.audit(requester, 'convidar_externo', invite.userId ?? invite.id, email);
    return { id: invite.id, email, expiresAt };
  }

  async renewInvite(requester: Requester, id: number, days: unknown) {
    const invite = await this.prisma.externalInvite.findFirst({ where: { id, companyId: requester.companyId } });
    if (!invite) throw new NotFoundException('Convite não encontrado');
    if (invite.revokedAt) throw new ConflictException('Convite revogado: crie um novo.');
    await this.assertGrantableProfile(requester, invite.profileId);
    const expiresAt = this.daysFrom(days);
    await this.prisma.externalInvite.update({ where: { id }, data: { expiresAt, warnedAt: null } });
    if (invite.userId) {
      await this.assertNotSuperTarget(requester, invite.userId);
      await this.syncInvitedUser(invite.userId, { externalUntil: expiresAt, reactivate: false });
    }
    await this.audit(requester, 'renovar_externo', invite.userId ?? invite.id, invite.email);
    return { id, expiresAt };
  }

  /** Revoga: convite fechado, usuário inativo e todas as sessões dele derrubadas. */
  async revokeInvite(requester: Requester, id: number) {
    const invite = await this.prisma.externalInvite.findFirst({ where: { id, companyId: requester.companyId } });
    if (!invite) throw new NotFoundException('Convite não encontrado');
    const now = new Date();
    if (invite.userId) await this.assertNotSuperTarget(requester, invite.userId);
    await this.prisma.externalInvite.update({ where: { id }, data: { revokedAt: invite.revokedAt ?? now } });
    if (invite.userId) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: invite.userId }, data: { active: false, inactiveAt: now } }),
        this.prisma.session.updateMany({ where: { userId: invite.userId, inactiveAt: null }, data: { inactiveAt: now } }),
      ]);
      await this.authCache.invalidateUserCache(invite.userId);
    }
    await this.audit(requester, 'revogar_externo', invite.userId ?? invite.id, invite.email);
    return { ok: true };
  }

  /** Mesma regra do CRUD de usuário: só o super mexe em usuário super. */
  private async assertNotSuperTarget(requester: Requester, userId: number) {
    if (requester.profile === 'super') return;
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { profile: { select: { name: true } } } });
    if (u?.profile?.name === 'super') throw new ForbiddenException('Só o super altera um usuário super.');
  }

  private async syncInvitedUser(userId: number, d: { profileId?: number; externalUntil: Date; reactivate: boolean }) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        externalUntil: d.externalUntil,
        ...(d.profileId ? { profileId: d.profileId } : {}),
        ...(d.reactivate ? { active: true, inactiveAt: null } : {}),
      },
    });
    await this.authCache.invalidateUserCache(userId);
  }

  // ---------------------------------------------------------- configuração

  async getSettings(companyId: number) {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { google_domain: true, google_login_enabled: true },
    });
    return {
      googleDomain: c?.google_domain ?? null,
      googleLoginEnabled: Boolean(c?.google_login_enabled),
      googleConfigured: this.oidc.configured,
    };
  }

  async updateSettings(requester: Requester, body: { googleDomain?: unknown; googleLoginEnabled?: unknown }) {
    const raw = body?.googleDomain === null ? '' : String(body?.googleDomain ?? '').trim().toLowerCase();
    const domain = raw.replace(/^@/, '') || null;
    if (domain && !DOMAIN_RE.test(domain)) throw new BadRequestException('Domínio inválido (ex.: suaempresa.com.br).');
    const enabled = body?.googleLoginEnabled === true;
    if (enabled && !domain) throw new BadRequestException('Informe o domínio antes de ligar o login com Google.');
    if (enabled && !this.oidc.configured) {
      throw new BadRequestException('O login com Google ainda não foi configurado no servidor (chaves do Google Cloud).');
    }
    if (domain) {
      const other = await this.prisma.company.findFirst({ where: { google_domain: domain, id: { not: requester.companyId } } });
      if (other) throw new ConflictException('Este domínio já está em outra empresa.');
    }
    const before = await this.getSettings(requester.companyId);
    // ligando agora: quem do domínio estava logado por senha sai (sessões de até
    // 7 dias abertas antes da regra) e volta pelo Google
    const turningOn = enabled && (!before.googleLoginEnabled || before.googleDomain !== domain);
    await this.prisma.company.update({
      where: { id: requester.companyId },
      data: { google_domain: domain, google_login_enabled: enabled },
    });
    if (turningOn && domain) {
      const domainUsers = await this.prisma.user.findMany({
        where: { companyId: requester.companyId, email: { endsWith: `@${domain}`, mode: 'insensitive' }, id: { not: requester.sub } },
        select: { id: true },
      });
      const ids = domainUsers.map((u) => u.id);
      if (ids.length) {
        await this.prisma.session.updateMany({ where: { userId: { in: ids }, inactiveAt: null }, data: { inactiveAt: new Date() } });
        await Promise.all(ids.map((uid) => this.authCache.invalidateUserCache(uid)));
      }
    }
    await this.prisma.system_Logs.create({
      data: {
        companyId: requester.companyId, userId: requester.sub, action: 'config_login_google', entity: 'company',
        entityId: requester.companyId, column: 'google_login_enabled',
        oldValue: `${before.googleDomain ?? ''}|${before.googleLoginEnabled}`, newValue: `${domain ?? ''}|${enabled}`,
      },
    });
    return this.getSettings(requester.companyId);
  }

  // -------------------------------------------------------------- avisos

  private emailReady() {
    if (this.email.isInitialized()) return true;
    const user = process.env.EMAIL_USER || '';
    const pass = process.env.EMAIL_PASSWORD || '';
    if (!user || !pass) return false;
    this.email.initialize({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587', 10),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: { user, pass },
      from: process.env.EMAIL_FROM || user,
    });
    return true;
  }

  private async usersWith(companyId: number, permission: string) {
    const has = { some: { inactiveAt: null, permission: { name: permission } } };
    return this.prisma.user.findMany({
      where: {
        companyId, active: true, inactiveAt: null,
        OR: [{ profile: { permissions: has } }, { permissions: has }],
      },
      select: { email: true, name: true },
    });
  }

  private async notifyApprovers(companyId: number, name: string, email: string, message: string | null) {
    if (process.env.NODE_ENV === 'test' || !this.emailReady()) return;
    const to = (await this.usersWith(companyId, 'aprovar_acesso_user')).map((u) => u.email).filter(Boolean);
    if (!to.length) return;
    await this.email.sendEmail({
      to,
      subject: `Pedido de acesso ao sistema: ${name}`.slice(0, 150),
      html: `<div style="font-family:Arial,sans-serif;max-width:560px">
        <p><b>${esc(name)}</b> (${esc(email)}) entrou com o Google e pediu um perfil de acesso.</p>
        ${message ? `<p style="color:#555">“${esc(message)}”</p>` : ''}
        <p><a href="${frontUrl()}/usuarios/pedidos-acesso">Abrir os pedidos de acesso</a></p>
      </div>`,
    });
  }

  /** Avisa quem convidou, alguns dias antes, que o acesso do convidado vai vencer. */
  @Cron('0 0 11 * * *')
  async warnTick() {
    if (process.env.NODE_ENV === 'test') return;
    await this.warnExpiring().catch((e) => this.logger.warn(`aviso de convites falhou: ${(e as Error).message}`));
  }

  async warnExpiring(now = new Date()) {
    const soon = await this.prisma.externalInvite.findMany({
      where: { revokedAt: null, warnedAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + WARN_DAYS * 86400000) } },
      include: { invitedBy: { select: { email: true, name: true } } },
    });
    if (!soon.length) return { warned: 0 };
    const canSend = process.env.NODE_ENV !== 'test' && this.emailReady();
    for (const inv of soon) {
      if (canSend && inv.invitedBy?.email) {
        await this.email
          .sendEmail({
            to: inv.invitedBy.email,
            subject: `Acesso de ${inv.email} vence em breve`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px">
              <p>O acesso do convidado <b>${esc(inv.email)}</b> vence em ${inv.expiresAt.toLocaleDateString('pt-BR', { timeZone: 'America/Recife' })}.</p>
              <p><a href="${frontUrl()}/usuarios/convidados">Renovar ou deixar vencer</a></p>
            </div>`,
          })
          .catch(() => undefined);
      }
      await this.prisma.externalInvite.update({ where: { id: inv.id }, data: { warnedAt: now } });
    }
    return { warned: soon.length };
  }

  private async audit(requester: Requester, action: string, entityId: number, value: string) {
    await this.prisma.system_Logs.create({
      data: {
        companyId: requester.companyId, userId: requester.sub, action, entity: 'user',
        entityId, column: 'email', oldValue: null, newValue: value,
      },
    });
  }
}
