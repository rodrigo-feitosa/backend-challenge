import type { EntityManager } from '@mikro-orm/core';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Cursor opaco para a próxima página; null quando não há mais itens. */
  nextCursor: string | null;
}

export interface LedgerRepository {
  /** Insere um lançamento avulso (ex.: OPENING) na transação corrente. */
  insert(entry: WalletLedgerEntry, em: EntityManager): Promise<void>;

  /**
   * Paginação por cursor estável: ordenação (created_at, id) crescente;
   * cursor opaco = base64 de { createdAt, id }.
   */
  listByWallet(walletId: string, limit: number, cursor: string | undefined, em: EntityManager): Promise<LedgerPage>;
}
