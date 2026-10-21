import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { DomainExceptionFilter } from './shared/infrastructure/http/domain-exception.filter';
import { RepositoriesModule } from './shared/infrastructure/repositories.module';
import { SharedModule } from './shared/shared.module';
import { SqsModule } from './messaging/infrastructure/sqs/sqs.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './wallets/wallets.module';
import { WageringModule } from './wagering/wagering.module';

/**
 * Módulo raiz. Módulos de domínio (messaging, auth) são adicionados
 * conforme as etapas do IMPLEMENTACAO-ETAPAS.md.
 */
@Module({
  imports: [
    SharedModule,
    DatabaseModule,
    RepositoriesModule,
    SqsModule,
    HealthModule,
    WageringModule,
    WalletsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
