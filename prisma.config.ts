import * as dotenv from 'dotenv';

// Carrega as variáveis de ambiente antes do Prisma processar
dotenv.config();

export default {
  schema: './prisma/schema/',
};
