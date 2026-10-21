import { Module } from '@nestjs/common';
import { SqsWagerConsumer } from './infrastructure/sqs-wager-consumer';
import { ConsumeWagerTransactionHandler } from './application/consume-wager-transaction.handler';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { WageringModule } from '../wagering/wagering.module';

/**
 * Módulo de mensageria: consumer SQS + handler (reutiliza o use case de
 * submissão do WageringModule). Outbox publisher e workers chegam na ET12.
 */
@Module({
  imports: [SqsModule, WageringModule],
  providers: [SqsWagerConsumer, ConsumeWagerTransactionHandler],
})
export class MessagingModule {}
