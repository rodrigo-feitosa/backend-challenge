import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { DomainExceptionFilter } from './shared/infrastructure/http/domain-exception.filter';
import { SharedModule } from './shared/shared.module';
import { SqsModule } from './messaging/infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './wallets/wallets.module';

/**
 * Módulo raiz. Módulos de domínio (wagering, messaging, auth) são
 * adicionados conforme as etapas do IMPLEMENTACAO-ETAPAS.md.
 */
@Module({
  imports: [SharedModule, DatabaseModule, SqsModule, HealthModule, WalletsModule],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
