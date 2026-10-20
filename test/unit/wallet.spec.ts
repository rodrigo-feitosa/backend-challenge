import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { InsufficientFundsError, ReversalWouldOverdrawError } from '../../src/wallets/domain/errors';
import { Wallet } from '../../src/wallets/domain/wallet';

const AT = new Date('2026-01-15T12:00:00.000Z');
const AT2 = new Date('2026-01-15T12:01:00.000Z');

function walletWith(balance: string): Wallet {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: Money.from({ amount: balance, currency: 'BRL' }) });
}

function meta(overrides?: Partial<{ transactionId: string; entryId: string; cause: 'BET' | 'ROLLBACK' | 'WIN' | 'REFUND'; at: Date }>) {
  return {
    transactionId: 'tx-1',
    entryId: 'entry-1',
    cause: 'BET' as const,
    at: AT,
    ...overrides,
  };
}

describe('Wallet.open', () => {
  it('cria com version=1, saldo inicial e getters corretos', () => {
    const wallet = walletWith('100.00');
    expect(wallet.id).toBe('w-1');
    expect(wallet.playerId).toBe('p-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejeita saldo inicial negativo', () => {
    const negative = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '11.00', currency: 'BRL' }),
    );
    expect(() => Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: negative })).toThrow();
  });

  it('aceita saldo inicial zero', () => {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: Money.zero('BRL') });
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejeita id/playerId vazios', () => {
    expect(() => Wallet.open({ id: '', playerId: 'p-1', initialBalance: Money.zero('BRL') })).toThrow();
    expect(() => Wallet.open({ id: 'w-1', playerId: '  ', initialBalance: Money.zero('BRL') })).toThrow();
  });
});

describe('Wallet.debit', () => {
  it('reduz o saldo, incrementa version e cria entrada DEBIT pendente', () => {
    const wallet = walletWith('100.00');
    const { entry } = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), meta());
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.pendingEntries).toHaveLength(1);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.isBalanced()).toBe(true);
  });

  it('deixa o saldo em zero quando debita exatamente todo o saldo', () => {
    const wallet = walletWith('25.00');
    wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), meta());
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejeita saldo insuficiente com InsufficientFundsError, sem alterar estado', () => {
    const wallet = walletWith('10.00');
    expect(() =>
      wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), meta()),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallet.pendingEntries).toHaveLength(0);
  });

  it('ROLLBACK que deixaria saldo negativo lança ReversalWouldOverdrawError (código distinto, regra 7.9)', () => {
    const wallet = walletWith('10.00');
    try {
      wallet.debit(
        Money.from({ amount: '25.00', currency: 'BRL' }),
        meta({ cause: 'ROLLBACK' }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReversalWouldOverdrawError);
      expect((err as ReversalWouldOverdrawError).code).toBe('REVERSAL_WOULD_OVERDRAW');
      expect(err).not.toBeInstanceOf(InsufficientFundsError);
    }
  });

  it('BET que deixaria saldo negativo lança INSUFFICIENT_FUNDS (código distinto do anterior)', () => {
    try {
      walletWith('10.00').debit(Money.from({ amount: '25.00', currency: 'BRL' }), meta());
      expect.unreachable();
    } catch (err) {
      expect((err as InsufficientFundsError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  it('rejeita valor zero/negativo e moeda divergente', () => {
    const wallet = walletWith('10.00');
    expect(() => wallet.debit(Money.zero('BRL'), meta())).toThrow(InvalidMoneyError);
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), meta())).toThrow(
      CurrencyMismatchError,
    );
  });

  it('atualiza updatedAt com o instante informado', () => {
    const wallet = walletWith('10.00');
    wallet.debit(Money.from({ amount: '1.00', currency: 'BRL' }), meta({ at: AT2 }));
    expect(wallet.updatedAt).toBe(AT2);
  });
});

describe('Wallet.credit', () => {
  it('aumenta o saldo, incrementa version e cria entrada CREDIT', () => {
    const wallet = walletWith('0.00');
    const { entry } = wallet.credit(
      Money.from({ amount: '50.00', currency: 'BRL' }),
      meta({ cause: 'WIN' }),
    );
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('50.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('encadeia múltiplas operações com before/after coerentes', () => {
    const wallet = walletWith('100.00');
    wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }), meta({ entryId: 'e1' }));
    wallet.credit(Money.from({ amount: '20.00', currency: 'BRL' }), meta({ entryId: 'e2', cause: 'WIN', at: AT2 }));
    wallet.debit(Money.from({ amount: '10.00', currency: 'BRL' }), meta({ entryId: 'e3', at: AT2 }));
    expect(wallet.balance.toString()).toBe('80.00');
    expect(wallet.version).toBe(4);
    const entries = wallet.pendingEntries;
    expect(entries).toHaveLength(3);
    expect(entries[0]!.balanceAfter.toString()).toBe('70.00');
    expect(entries[1]!.balanceBefore.toString()).toBe('70.00');
    expect(entries[1]!.balanceAfter.toString()).toBe('90.00');
    expect(entries[2]!.balanceBefore.toString()).toBe('90.00');
    expect(entries[2]!.balanceAfter.toString()).toBe('80.00');
    for (const entry of entries) expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita crédito zero e moeda divergente', () => {
    const wallet = walletWith('10.00');
    expect(() => wallet.credit(Money.zero('BRL'), meta({ cause: 'WIN' }))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), meta({ cause: 'WIN' }))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('Wallet.rehydrate', () => {
  it('reproduz o estado exato sem revalidar', () => {
    const wallet = walletWith('100.00');
    wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), meta());
    const state = {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
    const restored = Wallet.rehydrate(state);
    expect(restored.balance.toString()).toBe('75.00');
    expect(restored.version).toBe(2);
    expect(restored.updatedAt).toBe(AT);
    expect(restored.pendingEntries).toHaveLength(0);
  });

  it('não revalida: restaura estado persistido tal como está', () => {
    // versão arbitrária e saldo zero — estado persistido é a verdade
    const restored = Wallet.rehydrate({
      id: 'w-9',
      playerId: 'p-9',
      currency: 'BRL',
      balance: Money.zero('BRL'),
      version: 42,
      createdAt: AT,
      updatedAt: AT2,
    });
    expect(restored.version).toBe(42);
    expect(restored.balance.isZero()).toBe(true);
  });
});

describe('Wallet.pullPendingEntries', () => {
  it('entrega e limpa as entradas pendentes', () => {
    const wallet = walletWith('100.00');
    wallet.debit(Money.from({ amount: '1.00', currency: 'BRL' }), meta());
    expect(wallet.pullPendingEntries()).toHaveLength(1);
    expect(wallet.pendingEntries).toHaveLength(0);
  });
});
