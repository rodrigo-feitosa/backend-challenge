import { Money } from '../../shared/domain/money';
import { DomainError } from '../../shared/domain/errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('LEDGER_ENTRY_INVALID', message);
  }
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Estado persistido — usado apenas por `rehydrate` (não revalida). */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger — IMUTÁVEL por construção [R5.5]:
 * todos os campos `readonly`, nenhum setter, nenhum método de transição.
 * `create` valida a aritmética (balanceBefore ± money === balanceAfter,
 * exato, sobre Money); `rehydrate` apenas reconstrói estado já persistido [S6.0].
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty('id', props.id);
    assertNonEmpty('walletId', props.walletId);
    assertNonEmpty('transactionId', props.transactionId);
    if (!(props.createdAt instanceof Date) || Number.isNaN(props.createdAt.getTime())) {
      throw new InvalidLedgerEntryError('createdAt must be a valid Date');
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger amount must be positive (zero/negative movements do not generate entries)');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError('ledger entry requires a single currency across amount and balances');
    }
    const expectedAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);
    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} !== ${props.balanceAfter.toString()}`,
      );
    }
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida regras [S6.0]. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter — verdadeiro para entradas criadas pela factory. */
  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expectedAfter.equals(this.balanceAfter);
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLedgerEntryError(`${field} must be a non-empty string`);
  }
}
