import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const PORT = process.env.PORT || 3000;
const ORIGIN_CORS = process.env.ORIGIN_CORS || '*';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ORIGIN_CORS,
    credentials: true,
  });
  const server = await app.listen(PORT);
  const { port: actualPort } = server.address();
  console.log(`Application is running on Port ${actualPort}`);
}
bootstrap();
