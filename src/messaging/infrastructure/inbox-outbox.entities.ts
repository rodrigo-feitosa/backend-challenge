import { EntitySchema } from '@mikro-orm/core';

/**
 * Entidades MikroORM de inbox e outbox — somente infraestrutura.
 * Os domínios (InboxMessage, OutboxMessage, IntegrationEvent) serão
 * mapeados nos repositórios (ET10/ET11).
 */
export class InboxMessageEntity {
  id!: string;
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageEntity>({
  class: InboxMessageEntity,
  tableName: 'inbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    consumerName: { type: 'string', fieldName: 'consumer_name', length: 64 },
    messageId: { type: 'string', fieldName: 'message_id', length: 128 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    receivedAt: { type: 'datetime', fieldName: 'received_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
  },
});

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  version!: number;
  payload!: string; // coluna jsonb; driver entrega string
  occurredAt!: Date;
  status!: string;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  correlationId!: string;
  causationId!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id', length: 64 },
    eventType: { type: 'string', fieldName: 'event_type', length: 64 },
    version: { type: 'number', fieldName: 'version' },
    payload: { type: 'json', fieldName: 'payload' },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at' },
    status: { type: 'string', fieldName: 'status', length: 12 },
    attempts: { type: 'number', fieldName: 'attempts' },
    nextAttemptAt: { type: 'datetime', nullable: true, fieldName: 'next_attempt_at' },
    publishedAt: { type: 'datetime', nullable: true, fieldName: 'published_at' },
    correlationId: { type: 'string', fieldName: 'correlation_id', length: 64 },
    causationId: { type: 'string', nullable: true, fieldName: 'causation_id', length: 64 },
  },
});
