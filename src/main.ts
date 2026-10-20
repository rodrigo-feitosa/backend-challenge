import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PinoNestLogger, createLogger } from './shared/infrastructure/logging/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new PinoNestLogger(),
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // SIGTERM/SIGINT → Nest executa onApplicationShutdown dos módulos
  // (consumer para o polling e conclui/devolve mensagens in-flight).
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  createLogger('bootstrap').info(`HTTP listening on :${port}`);
}

void bootstrap();
