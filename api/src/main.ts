import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // Front em desenvolvimento roda no Vite (porta 5173 por padrão).
  // Aceita lista separada por vírgulas e habilita cookies de sessão.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: corsOrigins, credentials: true });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
