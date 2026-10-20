import { Money } from '../../shared/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../shared/domain/errors';
import { InsufficientFundsError, ReversalWouldOverdrawError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/**
 * Causa do movimento — espelha os kinds das transações (sem dependência
 * do módulo wagering: o domínio de wallets permanece independente).
 */
export type LedgerCause = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface DebitMeta {
  transactionId: string;
  /** entryId é gerado pelo use case (IdGeneratorPort, ADR-008). */
  entryId: string;
  cause: LedgerCause;
  at: Date;
}

export type CreditMeta = DebitMeta;

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

/**
 * Aggregate Root da wallet (§6.2). O estado é encapsulado; toda mutação
 * passa por `debit`/`credit`, que mantêm saldo e ledger consistentes entre si:
 * cada chamada cria o `WalletLedgerEntry` correspondente (before/after
 * verificados na factory) e o acumula como pendente para a persistência
 * na MESMA transação (invariante §6.2).
 *
 * `version` inicia em 1 e incrementa somente quando o saldo muda —
 * OPENING não passa por aqui (o saldo inicial já nasce no `open`, versão 1),
 * e LOSS não altera saldo.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
    private _pendingEntries: WalletLedgerEntry[],
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (typeof props.id !== 'string' || props.id.trim() === '') {
      throw new InvalidWalletError('wallet id must be a non-empty string');
    }
    if (typeof props.playerId !== 'string' || props.playerId.trim() === '') {
      throw new InvalidWalletError('playerId must be a non-empty string');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance must not be negative');
    }
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
      [],
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida transições [S6.0]. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      [],
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Entradas criadas e ainda não persistidas (persistidas na mesma transação). */
  get pendingEntries(): readonly WalletLedgerEntry[] {
    return this._pendingEntries;
  }

  /**
   * Débito (BET, ou ROLLBACK de WIN/REFUND). Valida moeda, positividade e
   * não-negatividade do saldo resultante. Distinguindo a causa: ROLLBACK
   * que deixaria o saldo negativo é `REVERSAL_WOULD_OVERDRAW` (regra 7.9),
   * não `INSUFFICIENT_FUNDS`.
   */
  debit(amount: Money, meta: DebitMeta): { entry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);
    assertPositive(amount, 'debit');
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(amount);
    if (balanceAfter.isNegative()) {
      throw meta.cause === 'ROLLBACK'
        ? new ReversalWouldOverdrawError(
            `reversal would overdraw wallet ${this.id}: ${balanceBefore.toString()} < ${amount.toString()}`,
          )
        : new InsufficientFundsError(
            `insufficient funds on wallet ${this.id}: ${balanceBefore.toString()} < ${amount.toString()}`,
          );
    }
    return this.apply(amount, balanceBefore, balanceAfter, LedgerDirection.Debit, meta);
  }

  /** Crédito (WIN, REFUND, ROLLBACK de BET). Crédito nunca negativiza o saldo. */
  credit(amount: Money, meta: CreditMeta): { entry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);
    assertPositive(amount, 'credit');
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(amount);
    return this.apply(amount, balanceBefore, balanceAfter, LedgerDirection.Credit, meta);
  }

  /**
   * Entrega e limpa as entradas pendentes — o repositório persiste
   * saldo + entradas na mesma transação SQL (§6.5).
   */
  pullPendingEntries(): WalletLedgerEntry[] {
    const entries = this._pendingEntries;
    this._pendingEntries = [];
    return entries;
  }

  private apply(
    amount: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    direction: LedgerDirection,
    meta: DebitMeta,
  ): { entry: WalletLedgerEntry } {
    const entry = WalletLedgerEntry.create({
      id: meta.entryId,
      walletId: this.id,
      transactionId: meta.transactionId,
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: meta.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = meta.at;
    this._pendingEntries.push(entry);
    return { entry };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `operation currency ${money.currency} does not match wallet currency ${this.currency}`,
      );
    }
  }
}

function assertPositive(amount: Money, operation: string): void {
  if (!amount.isPositive()) {
    throw new InvalidMoneyError(`${operation} amount must be positive`);
  }
}
