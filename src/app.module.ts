import { Module } from '@nestjs/common';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { SqsModule } from './messaging/infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';

/**
 * Módulo raiz. Módulos de domínio (wallets, wagering, messaging, auth)
 * são adicionados conforme as etapas do IMPLEMENTACAO-ETAPAS.md.
 */
@Module({
  imports: [DatabaseModule, SqsModule, HealthModule],
})
export class AppModule {}
