import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { correlationMiddleware } from './shared/infrastructure/logging/correlation';

/**
 * Configuração comum da aplicação — usada pelo main.ts e pelos testes
 * de integração (mesmos pipes e hooks em qualquer ambiente).
 */
export function configureApp(app: INestApplication): void {
  // contexto de correlação para todos os logs do request (seção 12)
  app.use(correlationMiddleware);
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
}
