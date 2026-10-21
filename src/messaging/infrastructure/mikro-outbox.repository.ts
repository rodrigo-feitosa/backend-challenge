import type { EntityManager } from '@mikro-orm/core';
import type { OutboxRepository } from '../application/ports/outbox-repository';
import { OutboxMessage, type OutboxMessageState, type OutboxStatus } from '../domain/outbox-message';
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

  async claimPending(limit: number, em: EntityManager): Promise<OutboxMessage[]> {
    const rows = (await em.getConnection().execute(
      `SELECT * FROM outbox_messages
        WHERE status = 'PENDING'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY next_attempt_at NULLS FIRST, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [limit],
    )) as OutboxRow[];
    return rows.map((row) => this.toDomain(row));
  }

  async lockById(id: string, em: EntityManager): Promise<OutboxMessage | null> {
    const rows = (await em.getConnection().execute(
      `SELECT * FROM outbox_messages WHERE id = ?::uuid FOR UPDATE`,
      [id],
    )) as OutboxRow[];
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async update(message: OutboxMessage, em: EntityManager): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      {
        status: message.status,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
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

  private toDomain(row: OutboxRow): OutboxMessage {
    const state: OutboxMessageState = {
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      version: row.version,
      payload: row.payload as Record<string, unknown>,
      occurredAt: new Date(row.occurred_at),
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
      publishedAt: row.published_at ? new Date(row.published_at) : undefined,
      correlationId: row.correlation_id,
      causationId: row.causation_id ?? undefined,
    };
    return OutboxMessage.rehydrate(state);
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  version: number;
  payload: unknown;
  occurred_at: string | Date;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  published_at: string | null;
  correlation_id: string;
  causation_id: string | null;
}
