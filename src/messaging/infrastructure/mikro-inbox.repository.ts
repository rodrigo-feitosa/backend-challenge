import type { EntityManager } from '@mikro-orm/core';
import type { InboxRepository } from '../application/ports/inbox-repository';
import type { InboxMessage } from '../domain/inbox-message';
import { InboxMessageSchema } from './inbox-outbox.entities';

/**
 * Implementação MikroORM da inbox persistente.
 */
export class MikroInboxRepository implements InboxRepository {
  async insert(message: InboxMessage, em: EntityManager): Promise<void> {
    await em.insert(InboxMessageSchema, {
      id: message.id,
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}
