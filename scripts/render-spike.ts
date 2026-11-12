/**
 * Spike/manual: renderiza certificados pelo CertificateRenderService.
 * uso: DATABASE_URI=... npx ts-node -r tsconfig-paths/register scripts/render-spike.ts <saida> <key...>
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CertificateRenderService } from '../src/features/training/trainee_certificate/render/certificate-render.service';

async function main() {
  const [out, ...keys] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URI } } });
  const svc = new CertificateRenderService(prisma as any);
  for (const key of keys) {
    const cert = await svc.findByKey(key);
    const t = Date.now();
    writeFileSync(join(out, `${key.slice(0, 8)}-front.png`), await svc.renderPng(cert, 'front', 2));
    if (svc.hasBack(cert)) writeFileSync(join(out, `${key.slice(0, 8)}-back.png`), await svc.renderPng(cert, 'back', 2));
    const pdf = await svc.renderPdf(cert);
    writeFileSync(join(out, `${key.slice(0, 8)}.pdf`), pdf);
    console.log(key, Date.now() - t, 'ms', 'pdf', Math.round(pdf.length / 1024), 'KB', 'rss', Math.round(process.memoryUsage().rss / 1e6), 'MB');
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
