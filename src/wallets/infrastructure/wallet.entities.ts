import { EntitySchema } from '@mikro-orm/core';

/**
 * Entidades MikroORM do módulo wallets — SOMENTE infraestrutura [S6.1].
 * O domínio (Wallet, WalletLedgerEntry) permanece livre de decorators;
 * o mapeamento entidade ⇄ agregado é explícito, no repositório.
 *
 * Money é persistido como bigint em centavos + char(3) de moeda (ADR-002).
 * O driver retorna bigint como string — toda conversão é via string/BigInt,
 * nunca via number [R5.1].
 */

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceCents!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id', length: 64 },
    currency: { type: 'string', fieldName: 'currency', length: 3 },
    balanceCents: { type: 'bigint', fieldName: 'balance_cents' },
    version: { type: 'number', fieldName: 'version' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});

export class WalletLedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amountCents!: string;
  balanceBeforeCents!: string;
  balanceAfterCents!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', fieldName: 'direction', length: 6 },
    amountCents: { type: 'bigint', fieldName: 'amount_cents' },
    balanceBeforeCents: { type: 'bigint', fieldName: 'balance_before_cents' },
    balanceAfterCents: { type: 'bigint', fieldName: 'balance_after_cents' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});
