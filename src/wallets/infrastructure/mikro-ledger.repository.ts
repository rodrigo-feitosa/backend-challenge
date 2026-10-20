import type { EntityManager } from '@mikro-orm/core';
import { Money } from '../../shared/domain/money';
import { ValidationError } from '../../shared/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { LedgerPage, LedgerRepository } from '../application/ports/ledger-repository';
import { WalletLedgerEntrySchema } from './wallet.entities';

/**
 * Implementação MikroORM do repositório do ledger.
 * Cursor opaco = base64 de { createdAt: ISO, id }; ordenação (created_at, id)
 * crescente — estável sob inserções concorrentes (índice ix_entry_wallet_cursor).
 * A moeda vem da wallet (JOIN) — o ledger armazena apenas centavos.
 */

interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(entry: WalletLedgerEntry): string {
  const payload: CursorPayload = { createdAt: entry.createdAt.toISOString(), id: entry.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid ledger cursor');
  }
  const p = payload as Partial<CursorPayload>;
  if (typeof p.createdAt !== 'string' || typeof p.id !== 'string') {
    throw new ValidationError('invalid ledger cursor');
  }
  const date = new Date(p.createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('invalid ledger cursor');
  }
  return { createdAt: date.toISOString(), id: p.id };
}

export class MikroLedgerRepository implements LedgerRepository {
  async insert(entry: WalletLedgerEntry, em: EntityManager): Promise<void> {
    await em.insert(WalletLedgerEntrySchema, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amountCents: entry.money.toCents().toString(),
      balanceBeforeCents: entry.balanceBefore.toCents().toString(),
      balanceAfterCents: entry.balanceAfter.toCents().toString(),
      createdAt: entry.createdAt,
    });
  }

  async listByWallet(
    walletId: string,
    limit: number,
    cursor: string | undefined,
    em: EntityManager,
  ): Promise<LedgerPage> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const rows = (await em.getConnection().execute(
      after
        ? `SELECT l.*, w.currency
             FROM wallet_ledger_entries l
             JOIN wallets w ON w.id = l.wallet_id
            WHERE l.wallet_id = ?
              AND (l.created_at, l.id) > (?::timestamptz, ?::uuid)
            ORDER BY l.created_at, l.id
            LIMIT ?::int`
        : `SELECT l.*, w.currency
             FROM wallet_ledger_entries l
             JOIN wallets w ON w.id = l.wallet_id
            WHERE l.wallet_id = ?
            ORDER BY l.created_at, l.id
            LIMIT ?::int`,
      after ? [walletId, after.createdAt, after.id, limit] : [walletId, limit],
    )) as LedgerRow[];

    return this.toPage(rows, limit);
  }

  private toPage(rows: LedgerRow[], limit: number): LedgerPage {
    const items = rows.map(rowToDomain);
    const hasMore = items.length === limit;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount_cents: string;
  balance_before_cents: string;
  balance_after_cents: string;
  currency: string;
  created_at: Date;
}

function rowToDomain(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: Money.fromCents(row.amount_cents, row.currency),
    balanceBefore: Money.fromCents(row.balance_before_cents, row.currency),
    balanceAfter: Money.fromCents(row.balance_after_cents, row.currency),
    // raw SQL (knex) devolve timestamptz como string
    createdAt: new Date(row.created_at),
  });
}
