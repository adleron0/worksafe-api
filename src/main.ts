import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';

const PORT = process.env.PORT || 3000;
const ORIGIN_CORS = process.env.ORIGIN_CORS || '*';

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);
    app.enableCors({
      origin: ORIGIN_CORS,
      credentials: true,
    });
    const server = await app.listen(PORT);
    const { port: actualPort } = server.address();
    console.log(`Application is running on Port ${actualPort}`);
  } catch (error) {
    console.error('Erro ao inicializar a aplicação:', error);
    if (error instanceof PrismaClientInitializationError) {
      console.error('Erro de conexão com o banco de dados:', error.message);
    } else {
      console.error('Erro inesperado:', error);
    }
  }
}
bootstrap();
