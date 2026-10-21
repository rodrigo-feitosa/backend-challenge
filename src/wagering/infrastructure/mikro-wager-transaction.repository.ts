import { LockMode, type EntityManager } from '@mikro-orm/core';
import { Money } from '../../shared/domain/money';
import type { PendingReferenceSchedule, WagerTransactionRepository } from '../application/ports/wager-transaction-repository';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../domain/wager-transaction';
import { WagerTransactionEntity, WagerTransactionSchema } from './wager-transaction.entity';

/**
 * Implementação MikroORM do repositório de transações de aposta.
 * Mapeamento explícito domínio ⇄ entidade; Money ⇄ centavos via string/BigInt.
 */
export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  async insert(tx: WagerTransaction, em: EntityManager, balanceSnapshot?: Money): Promise<void> {
    await em.insert(WagerTransactionSchema, this.toRow(tx, balanceSnapshot, undefined));
  }

  async update(
    tx: WagerTransaction,
    em: EntityManager,
    options?: { balanceSnapshot?: Money; pendingReferenceSchedule?: PendingReferenceSchedule },
  ): Promise<void> {
    const snapshot = options?.balanceSnapshot;
    const schedule = options?.pendingReferenceSchedule;
    const data: Record<string, unknown> = {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      processedAt: tx.processedAt ?? null,
      balanceAfterCents: snapshot ? snapshot.toCents().toString() : null,
      balanceAfterCurrency: snapshot ? snapshot.currency : null,
    };
    if (schedule) {
      data.pendingReferenceAttempts = schedule.attempts;
      data.pendingReferenceNextRetryAt = schedule.nextRetryAt;
    }
    await em.nativeUpdate(WagerTransactionSchema, { id: tx.id }, data);
  }

  async findById(id: string, em: EntityManager): Promise<WagerTransaction | null> {
    const row = await em.findOne(WagerTransactionSchema, { id });
    return row ? this.toDomain(row) : null;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string, em: EntityManager): Promise<WagerTransaction | null> {
    const row = await em.findOne(WagerTransactionSchema, { providerId, idempotencyKey });
    return row ? this.toDomain(row) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string, em: EntityManager): Promise<WagerTransaction | null> {
    const row = await em.findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return row ? this.toDomain(row) : null;
  }

  async findReference(providerId: string, referenceExternalTransactionId: string, em: EntityManager): Promise<WagerTransaction | null> {
    const row = await em.findOne(WagerTransactionSchema, { providerId, externalTransactionId: referenceExternalTransactionId });
    return row ? this.toDomain(row) : null;
  }

  async existsActiveReversal(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK', em: EntityManager): Promise<boolean> {
    const count = await em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind,
      status: { $in: [WagerTransactionStatus.Processed, WagerTransactionStatus.PendingReference] },
    });
    return count > 0;
  }

  async readBalanceSnapshot(transactionId: string, em: EntityManager): Promise<Money | null> {
    const row = await em.findOne(
      WagerTransactionSchema,
      { id: transactionId },
      { fields: ['balanceAfterCents', 'balanceAfterCurrency'] },
    );
    if (!row?.balanceAfterCents || !row.balanceAfterCurrency) return null;
    return Money.fromCents(row.balanceAfterCents, row.balanceAfterCurrency);
  }

  async findPendingReferenceDue(limit: number, em: EntityManager): Promise<WagerTransaction[]> {
    const rows = (await em.getConnection().execute(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND pending_reference_next_retry_at <= now()
        ORDER BY pending_reference_next_retry_at
        LIMIT ?`,
      [limit],
    )) as { id: string }[];
    const transactions: WagerTransaction[] = [];
    for (const row of rows) {
      const tx = await em.findOne(WagerTransactionSchema, { id: row.id });
      if (tx) transactions.push(this.toDomain(tx));
    }
    return transactions;
  }

  async lockById(id: string, em: EntityManager): Promise<WagerTransaction | null> {
    const row = await em.findOne(WagerTransactionSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? this.toDomain(row) : null;
  }

  async incrementPendingReferenceAttempt(id: string, em: EntityManager): Promise<number | null> {
    const rows = (await em.getConnection().execute(
      `UPDATE wager_transactions
          SET pending_reference_attempts = pending_reference_attempts + 1
        WHERE id = ?::uuid AND status = 'PENDING_REFERENCE'
        RETURNING pending_reference_attempts`,
      [id],
    )) as { pending_reference_attempts: number }[];
    const row = rows[0];
    return row ? Number(row.pending_reference_attempts) : null;
  }

  async schedulePendingReferenceRetry(id: string, nextRetryAt: Date, em: EntityManager): Promise<void> {
    await em.nativeUpdate(
      WagerTransactionSchema,
      { id },
      { pendingReferenceNextRetryAt: nextRetryAt },
    );
  }

  private toRow(tx: WagerTransaction, balanceSnapshot: Money | undefined, schedule: PendingReferenceSchedule | undefined) {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      amountCents: tx.money.toCents().toString(),
      currency: tx.money.currency,
      referenceExternalTxId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      balanceAfterCents: balanceSnapshot ? balanceSnapshot.toCents().toString() : null,
      balanceAfterCurrency: balanceSnapshot ? balanceSnapshot.currency : null,
      failureCode: tx.failureCode ?? null,
      pendingReferenceAttempts: schedule ? schedule.attempts : 0,
      pendingReferenceNextRetryAt: schedule ? schedule.nextRetryAt : null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };
  }

  private toDomain(row: WagerTransactionEntity): WagerTransaction {
    const state: WagerTransactionState = {
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.fromCents(row.amountCents, row.currency),
      referenceExternalTransactionId: row.referenceExternalTxId ?? undefined,
      createdAt: row.createdAt,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: (row.failureCode ?? undefined) as WagerTransactionState['failureCode'],
      processedAt: row.processedAt ?? undefined,
    };
    return WagerTransaction.rehydrate(state);
  }
}
