import type { EntityManager } from '@mikro-orm/core';
import type { OutboxRepository } from '../application/ports/outbox-repository';
import { OutboxMessage } from '../domain/outbox-message';
import { OutboxMessageSchema } from './inbox-outbox.entities';

/**
 * Implementação MikroORM da outbox. As mensagens são gravadas na MESMA
 * transação SQL da alteração financeira; o payload é o envelope JSON do evento.
 */
export class MikroOutboxRepository implements OutboxRepository {
  async enqueue(message: OutboxMessage, em: EntityManager): Promise<void> {
    await em.insert(OutboxMessageSchema, this.toRow(message));
  }

  async enqueueMany(messages: OutboxMessage[], em: EntityManager): Promise<void> {
    if (messages.length === 0) return;
    await em.insertMany(OutboxMessageSchema, messages.map((m) => this.toRow(m)));
  }

  private toRow(message: OutboxMessage) {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      version: message.version,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      status: message.status,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
      correlationId: message.correlationId,
      causationId: message.causationId ?? null,
    };
  }
}
