import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URI } },
    });
  }
  return client;
}

/**
 * Zera todas as tabelas de dados preservando a estrutura e o histórico de
 * migrations. TRUNCATE ... CASCADE resolve a ordem de FKs sozinho, o que
 * importa aqui: o grafo de relações do schema tem ciclos (company -> user ->
 * company) e apagar na ordem certa à mão seria frágil.
 */
export async function resetDb(): Promise<void> {
  const db = testDb();

  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
