import type { EntityManager } from '@mikro-orm/core';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');

/**
 * Registro bruto de transação (row shape da tabela wager_transactions).
 * ET6/ET7 introduzirão o domínio WagerTransaction e substituirão este
 * formato por mapeamento entidade ⇄ agregado.
 */
export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  status: 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  amountCents: string;
  currency: string;
  referenceExternalTxId: string | null;
  referenceTransactionId: string | null;
  balanceAfterCents: string | null;
  balanceAfterCurrency: string | null;
  failureCode: string | null;
  pendingReferenceAttempts: number;
  pendingReferenceNextRetryAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface WagerTransactionRepository {
  insert(record: WagerTransactionRecord, em: EntityManager): Promise<void>;
}
