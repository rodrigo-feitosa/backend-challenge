import { Module } from '@nestjs/common';
import { DOMAIN_EVENT_COLLECTOR } from './application/domain-events';
import { NoopDomainEventCollector } from './application/noop-domain-event-collector';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { TransactionQueries } from './application/transaction-queries';
import { WageringController } from './presentation/wagering.controller';

/**
 * Módulo de wagering: o use case de submissão (compartilhado por HTTP e
 * SQS), queries e API HTTP. Os repositórios vêm do RepositoriesModule (global).
 */
@Module({
  controllers: [WageringController],
  providers: [
    SubmitWagerTransactionUseCase,
    TransactionQueries,
    { provide: DOMAIN_EVENT_COLLECTOR, useClass: NoopDomainEventCollector },
  ],
  exports: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
