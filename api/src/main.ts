import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  // Atrás do Traefik, req.ip (chave do rate limit de /api/explain) só é o cliente
  // real se confiarmos em N saltos de proxy. Padrão: desligado (0).
  const trustHops = Number(process.env.EXPLAIN_TRUST_PROXY);
  if (Number.isInteger(trustHops) && trustHops > 0 && trustHops <= 5) {
    app.set('trust proxy', trustHops);
  } else if (process.env.EXPLAIN_ENABLED === 'true') {
    // Sem trust proxy, atrás de um proxy reverso a chave do rate limit/orçamento por IP
    // vira o IP do proxy para todos. Aviso único no boot (sem segredos).
    new Logger('Explain').warn(
      'EXPLAIN_ENABLED=true but EXPLAIN_TRUST_PROXY is off: behind a reverse proxy all clients share one rate-limit/budget key. Set EXPLAIN_TRUST_PROXY=1 (Traefik -> nginx -> api).',
    );
  }
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
