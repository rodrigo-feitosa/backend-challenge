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

  /**
   * Reivindica mensagens pendentes e vencidas com FOR UPDATE SKIP LOCKED —
   * publishers concorrentes não processam a mesma mensagem e não bloqueiam
   * uns aos outros (ADR-005). As locks valem enquanto a transação estiver aberta.
   */
  claimPending(limit: number, em: EntityManager): Promise<OutboxMessage[]>;

  lockById(id: string, em: EntityManager): Promise<OutboxMessage | null>;

  update(message: OutboxMessage, em: EntityManager): Promise<void>;
}
