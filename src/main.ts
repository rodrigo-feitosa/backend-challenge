import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { PinoNestLogger, createLogger } from './shared/infrastructure/logging/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new PinoNestLogger(),
  });
  configureApp(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  createLogger('bootstrap').info(`HTTP listening on :${port}`);
}

void bootstrap();
