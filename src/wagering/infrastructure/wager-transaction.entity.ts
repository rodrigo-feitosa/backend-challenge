import { EntitySchema } from '@mikro-orm/core';

/**
 * Entidade MikroORM da tabela `wager_transactions` — somente infraestrutura.
 * O domínio (WagerTransaction) é mapeado para/de esta entidade nos repositórios.
 * `referenceTransactionId` é o id INTERNO da transação referenciada;
 * `referenceExternalTxId` é o id no provedor.
 * `balanceAfterCents`/`balanceAfterCurrency` é o snapshot para replay
 * idempotente (regra 7.7 do desafio).
 */
export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  status!: string;
  amountCents!: string;
  currency!: string;
  referenceExternalTxId!: string | null;
  referenceTransactionId!: string | null;
  balanceAfterCents!: string | null;
  balanceAfterCurrency!: string | null;
  failureCode!: string | null;
  pendingReferenceAttempts!: number;
  pendingReferenceNextRetryAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 64 },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id', length: 128 },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 192 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id', length: 64 },
    roundId: { type: 'string', fieldName: 'round_id', length: 128 },
    gameId: { type: 'string', fieldName: 'game_id', length: 128 },
    kind: { type: 'string', fieldName: 'kind', length: 16 },
    status: { type: 'string', fieldName: 'status', length: 20 },
    amountCents: { type: 'bigint', fieldName: 'amount_cents' },
    currency: { type: 'string', fieldName: 'currency', length: 3 },
    referenceExternalTxId: { type: 'string', nullable: true, fieldName: 'reference_external_tx_id', length: 128 },
    referenceTransactionId: { type: 'uuid', nullable: true, fieldName: 'reference_transaction_id' },
    balanceAfterCents: { type: 'bigint', nullable: true, fieldName: 'balance_after_cents' },
    balanceAfterCurrency: { type: 'string', nullable: true, fieldName: 'balance_after_currency', length: 3 },
    failureCode: { type: 'string', nullable: true, fieldName: 'failure_code', length: 64 },
    pendingReferenceAttempts: { type: 'number', fieldName: 'pending_reference_attempts' },
    pendingReferenceNextRetryAt: { type: 'datetime', nullable: true, fieldName: 'pending_reference_next_retry_at' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
  },
});
