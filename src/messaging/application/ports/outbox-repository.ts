import type { EntityManager } from '@mikro-orm/core';
import type { OutboxMessage } from '../../domain/outbox-message';

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

/**
 * Porta do repositório da outbox. O enqueue acontece na MESMA transação
 * da alteração financeira (§11). Os métodos de consulta/claim para o
 * worker (SKIP LOCKED) entram na ET12.
 */
export interface OutboxRepository {
  enqueue(message: OutboxMessage, em: EntityManager): Promise<void>;
  enqueueMany(messages: OutboxMessage[], em: EntityManager): Promise<void>;
}
