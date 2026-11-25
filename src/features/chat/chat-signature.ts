import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeSettings, signatureName } from './chat.settings';

/**
 * Nome que vai na frente da mensagem: a pessoa que respondeu ou, se foi o bot,
 * o nome dele. Só para o que sai pelo sistema (o celular e as mensagens
 * automáticas de fora do horário não levam), e só com a assinatura ligada no número.
 */
export async function signerOf(prisma: PrismaService, channel: { settings: unknown }, who: { userId?: number | null; botId?: number | null }): Promise<string | null> {
  const { assinatura } = normalizeSettings(channel.settings);
  if (!assinatura.enabled) return null;
  if (who.botId) {
    const bot = await prisma.ai_Bot.findUnique({ where: { id: who.botId }, select: { name: true, persona: true } }).catch(() => null);
    return signatureName(bot?.persona || bot?.name, 'primeiro');
  }
  if (who.userId) {
    const user = await prisma.user.findUnique({ where: { id: who.userId }, select: { name: true } }).catch(() => null);
    return signatureName(user?.name, assinatura.formato);
  }
  return null;
}
