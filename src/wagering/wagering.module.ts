import { Module } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { TransactionQueries } from './application/transaction-queries';
import { PendingReferenceWorker } from './application/workers/pending-reference.worker';
import { WageringController } from './presentation/wagering.controller';

/**
 * Módulo de wagering: o use case de submissão (compartilhado por HTTP e
 * SQS), queries, API HTTP e o worker de referências pendentes.
 */
@Module({
  controllers: [WageringController],
  providers: [SubmitWagerTransactionUseCase, TransactionQueries, PendingReferenceWorker],
  exports: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
