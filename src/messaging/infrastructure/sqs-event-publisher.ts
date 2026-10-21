import { Inject, Injectable } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type EventPublisherPort } from '../application/ports/event-publisher';
import { SQS_CLIENT, getSqsQueueUrls } from './sqs/sqs.module';
import type { OutboxMessage } from '../domain/outbox-message';

/**
 * Publicação dos eventos da outbox em `wagering-events.fifo`.
 * MessageDeduplicationId = eventId (at-least-once: duplicatas são seguras
 * para o consumidor, que deduplica por eventId); MessageGroupId = aggregateId.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisherPort {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(new SendMessageCommand({
      QueueUrl: getSqsQueueUrls().events,
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
    }));
  }
}
