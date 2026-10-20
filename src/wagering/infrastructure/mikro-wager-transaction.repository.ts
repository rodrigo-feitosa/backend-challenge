import type { EntityManager } from '@mikro-orm/core';
import type { WagerTransactionRecord, WagerTransactionRepository } from '../application/ports/wager-transaction-repository';
import { WagerTransactionSchema } from './wager-transaction.entity';

/**
 * Implementação MikroORM do repositório de transações de aposta.
 * (ET6/ET7: aqui entra o mapeamento domínio ⇄ entidade.)
 */
export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  async insert(record: WagerTransactionRecord, em: EntityManager): Promise<void> {
    await em.insert(WagerTransactionSchema, {
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      status: record.status,
      amountCents: record.amountCents,
      currency: record.currency,
      referenceExternalTxId: record.referenceExternalTxId,
      referenceTransactionId: record.referenceTransactionId,
      balanceAfterCents: record.balanceAfterCents,
      balanceAfterCurrency: record.balanceAfterCurrency,
      failureCode: record.failureCode,
      pendingReferenceAttempts: record.pendingReferenceAttempts,
      pendingReferenceNextRetryAt: record.pendingReferenceNextRetryAt,
      createdAt: record.createdAt,
      processedAt: record.processedAt,
    });
  }
}
