import { Module } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { TransactionQueries } from './application/transaction-queries';
import { WageringController } from './presentation/wagering.controller';

/**
 * Módulo de wagering: o use case de submissão (compartilhado por HTTP e
 * SQS), queries e API HTTP. Os eventos vão para a transactional outbox
 * (RepositoriesModule fornece o repositório).
 */
@Module({
  controllers: [WageringController],
  providers: [SubmitWagerTransactionUseCase, TransactionQueries],
  exports: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
