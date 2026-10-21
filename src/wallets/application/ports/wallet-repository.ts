import type { EntityManager } from '@mikro-orm/core';
import type { Wallet } from '../../domain/wallet';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface UpdateWalletOptions {
  /**
   * CAS (compare-and-swap): só aplica se o saldo no banco ainda for o
   * esperado — segunda barreira de defesa do ADR-003 (o lock pessimista
   * é a primeira). 0 linhas afetadas ⇒ modificação concorrente inesperada.
   */
  expectedBalanceCents?: bigint;
}

/**
 * Porta do repositório de wallets. A unidade de trabalho é explícita:
 * as operações recebem o EntityManager da transação corrente, de modo que
 * repositório e use case compartilhem a MESMA transação SQL (§6.5).
 * O import é type-only — nenhuma dependência de runtime ao ORM.
 */
export interface WalletRepository {
  /** Insere a wallet (e suas entradas pendentes) — usada na abertura. */
  insert(wallet: Wallet, em: EntityManager): Promise<void>;

  /** Atualiza saldo/version/updatedAt e persiste as entradas pendentes. */
  update(wallet: Wallet, em: EntityManager, options?: UpdateWalletOptions): Promise<void>;

  /** Busca sem lock (consultas). */
  findById(walletId: string, em: EntityManager): Promise<Wallet | null>;

  /**
   * Busca com lock pessimista de linha (SELECT ... FOR UPDATE) —
   * unidade de concorrência = walletId [R5.6], [R5.7].
   */
  lockById(walletId: string, em: EntityManager): Promise<Wallet | null>;
}
