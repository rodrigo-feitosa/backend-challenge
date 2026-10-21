import type { EntityManager } from '@mikro-orm/core';
import type { InboxMessage } from '../../domain/inbox-message';

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');

/**
 * Porta da inbox. O insert viola a UNIQUE (consumer_name, message_id)
 * quando a mensagem já foi processada — o use case interpreta como DUPLICATE.
 */
export interface InboxRepository {
  insert(message: InboxMessage, em: EntityManager): Promise<void>;
}
