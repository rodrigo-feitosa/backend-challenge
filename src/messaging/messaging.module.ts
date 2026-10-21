import { Module } from '@nestjs/common';
import { SqsWagerConsumer } from './infrastructure/sqs-wager-consumer';
import { SqsEventPublisher } from './infrastructure/sqs-event-publisher';
import { ConsumeWagerTransactionHandler } from './application/consume-wager-transaction.handler';
import { OutboxPublisherWorker } from './application/workers/outbox-publisher.worker';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { WageringModule } from '../wagering/wagering.module';
import { EVENT_PUBLISHER } from './application/ports/event-publisher';

/**
 * Módulo de mensageria: consumer SQS, publisher de eventos da outbox
 * e o worker do publisher. O worker de pending-reference está no
 * WageringModule (reexecuta o use case que vive lá).
 */
@Module({
  imports: [SqsModule, WageringModule],
  providers: [
    SqsWagerConsumer,
    ConsumeWagerTransactionHandler,
    SqsEventPublisher,
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    OutboxPublisherWorker,
  ],
})
export class MessagingModule {}
