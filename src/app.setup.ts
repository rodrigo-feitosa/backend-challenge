import { type INestApplication, ValidationPipe } from '@nestjs/common';

/**
 * Configuração comum da aplicação — usada pelo main.ts e pelos testes
 * de integração (mesmos pipes e hooks em qualquer ambiente).
 */
export function configureApp(app: INestApplication): void {
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
