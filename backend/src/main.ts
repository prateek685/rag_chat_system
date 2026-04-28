import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Graceful shutdown — triggers OnModuleDestroy on SIGTERM so BullMQ/Prisma/Redis
  // connections close cleanly before the Docker container exits.
  app.enableShutdownHooks();

  // Standard security headers (X-Frame-Options, CSP, HSTS, etc.) — one line of defense for free.
  app.use(helmet());

  const configService = app.get(ConfigService);

  // Whitelist the frontend origin and the custom session header; credentials: true
  // is required for x-session-id to be forwarded by the browser.
  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL', 'http://localhost:3001'),
    credentials: true,
    allowedHeaders: ['Content-Type', 'x-session-id'],
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('RAG Chat System API')
    .setDescription('Open, login-free RAG chat platform')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-session-id' }, 'session-id')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('PORT', 8080);
  await app.listen(port);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
