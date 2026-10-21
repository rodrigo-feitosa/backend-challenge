import type { EntityManager } from '@mikro-orm/core';
import type { Money } from '../../../shared/domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');

export interface PendingReferenceSchedule {
  attempts: number;
  nextRetryAt: Date;
}

/**
 * Porta do repositório de transações de aposta. As operações recebem o
 * EntityManager da transação corrente (§6.5: tudo na mesma transação SQL).
 * O snapshot de saldo (balance_after_*) é persistência da regra 7.7 —
 * fica fora do agregado e entra como parâmetro opcional.
 */
export interface WagerTransactionRepository {
  insert(tx: WagerTransaction, em: EntityManager, balanceSnapshot?: Money): Promise<void>;

  update(
    tx: WagerTransaction,
    em: EntityManager,
    options?: { balanceSnapshot?: Money; pendingReferenceSchedule?: PendingReferenceSchedule },
  ): Promise<void>;

  findById(id: string, em: EntityManager): Promise<WagerTransaction | null>;

  findByIdempotencyKey(providerId: string, idempotencyKey: string, em: EntityManager): Promise<WagerTransaction | null>;

  /** Lookup por (provider, external) — usado no replay de conflito e em consultas. */
  findByProviderAndExternalId(providerId: string, externalTransactionId: string, em: EntityManager): Promise<WagerTransaction | null>;

  /** Referência é resolvida por (providerId, referenceExternalTransactionId) — regra 7.2. */
  findReference(providerId: string, referenceExternalTransactionId: string, em: EntityManager): Promise<WagerTransaction | null>;

  /** Regra 7.4: já existe reversão ATIVA da referência pelo mesmo kind? */
  existsActiveReversal(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK', em: EntityManager): Promise<boolean>;

  /** Snapshot de saldo no momento do processamento (regra 7.7, replay). */
  readBalanceSnapshot(transactionId: string, em: EntityManager): Promise<Money | null>;

  /** Transações PENDING_REFERENCE vencidas para o worker (7.1) — sem lock. */
  findPendingReferenceDue(limit: number, em: EntityManager): Promise<WagerTransaction[]>;

  /** Lock pessimista na transação (worker de pendências entre instâncias). */
  lockById(id: string, em: EntityManager): Promise<WagerTransaction | null>;

  /** Incremento atômico do contador de tentativas; null se não estiver mais PENDING_REFERENCE. */
  incrementPendingReferenceAttempt(id: string, em: EntityManager): Promise<number | null>;

  /** Agenda a próxima tentativa do worker (backoff). */
  schedulePendingReferenceRetry(id: string, nextRetryAt: Date, em: EntityManager): Promise<void>;
}
