import { LockMode, type EntityManager } from '@mikro-orm/core';
import { Money } from '../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { WalletRepository } from '../application/ports/wallet-repository';
import { WalletLedgerEntrySchema, WalletSchema, type WalletEntity } from './wallet.entities';

/**
 * Implementação MikroORM do repositório de wallets (ADR-001).
 * Mapeamento explícito entidade ⇄ agregado; Money ⇄ centavos via string/BigInt
 * (exato nas duas direções, ADR-002). As entradas pendentes da wallet são
 * persistidas na MESMA transação do saldo — saldo e ledger nunca divergem.
 */

export class MikroWalletRepository implements WalletRepository {
  async insert(wallet: Wallet, em: EntityManager): Promise<void> {
    await em.insert(WalletSchema, toPersistence(wallet));
    await insertPendingEntries(wallet, em);
  }

  async update(wallet: Wallet, em: EntityManager): Promise<void> {
    await em.nativeUpdate(
      WalletSchema,
      { id: wallet.id },
      {
        balanceCents: wallet.balance.toCents().toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    await insertPendingEntries(wallet, em);
  }

  async findById(walletId: string, em: EntityManager): Promise<Wallet | null> {
    const row = await em.findOne(WalletSchema, { id: walletId });
    return row ? fromPersistence(row) : null;
  }

  async lockById(walletId: string, em: EntityManager): Promise<Wallet | null> {
    const row = await em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? fromPersistence(row) : null;
  }
}

function toPersistence(wallet: Wallet): WalletEntity {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceCents: wallet.balance.toCents().toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function fromPersistence(row: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.fromCents(row.balanceCents, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

async function insertPendingEntries(wallet: Wallet, em: EntityManager): Promise<void> {
  const pending = wallet.pendingEntries;
  if (pending.length === 0) return;
  await em.insertMany(
    WalletLedgerEntrySchema,
    pending.map((entry) => toEntryPersistence(entry)),
  );
  wallet.pullPendingEntries();
}

function toEntryPersistence(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amountCents: entry.money.toCents().toString(),
    balanceBeforeCents: entry.balanceBefore.toCents().toString(),
    balanceAfterCents: entry.balanceAfter.toCents().toString(),
    createdAt: entry.createdAt,
  };
}

export { toPersistence as walletToPersistence, fromPersistence as walletFromPersistence };
