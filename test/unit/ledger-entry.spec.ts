import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection, InvalidLedgerEntryError, WalletLedgerEntry } from '../../src/wallets/domain/wallet-ledger-entry';

const AT = new Date('2026-01-15T12:00:00.000Z');

const BRL = (amount: string) => Money.from({ amount, currency: 'BRL' });

function validProps(): Parameters<typeof WalletLedgerEntry.create>[0] {
  return {
    id: 'entry-1',
    walletId: 'w-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: BRL('25.00'),
    balanceBefore: BRL('100.00'),
    balanceAfter: BRL('75.00'),
    createdAt: AT,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('cria entrada DEBIT balanceada', () => {
    const entry = WalletLedgerEntry.create(validProps());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.createdAt).toBe(AT);
  });

  it('cria entrada CREDIT balanceada', () => {
    const entry = WalletLedgerEntry.create({
      ...validProps(),
      direction: LedgerDirection.Credit,
      money: BRL('50.00'),
      balanceBefore: BRL('0.00'),
      balanceAfter: BRL('50.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética incorreta (after divergente)', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...validProps(), balanceAfter: BRL('74.99') }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...validProps(), balanceAfter: BRL('125.00') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valor zero ou negativo', () => {
    expect(() => WalletLedgerEntry.create({ ...validProps(), money: BRL('0.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    const negative = BRL('1.00').subtract(BRL('2.00'));
    expect(() => WalletLedgerEntry.create({ ...validProps(), money: negative })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita moedas divergentes entre valor e saldos', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...validProps(), money: Money.from({ amount: '25.00', currency: 'USD' }) }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita ids vazios e data inválida', () => {
    expect(() => WalletLedgerEntry.create({ ...validProps(), id: '' })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...validProps(), transactionId: ' ' })).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...validProps(), createdAt: new Date('not-a-date') }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('reconstrói estado persistido sem revalidar', () => {
    const state = {
      ...validProps(),
      balanceAfter: BRL('74.99'), // persistido assim (estado é a verdade)
    };
    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.balanceAfter.toString()).toBe('74.99');
    expect(entry.isBalanced()).toBe(false); // consultável, mas a reconstrução não falha
  });
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  it('todos os campos são readonly (Object.keys corresponde aos 8 campos esperados)', () => {
    const entry = WalletLedgerEntry.create(validProps());
    const keys = Object.keys(entry).sort();
    expect(keys).toEqual(['balanceAfter', 'balanceBefore', 'createdAt', 'direction', 'id', 'money', 'transactionId', 'walletId']);
    // não há setters: a classe não possui métodos mutadores
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(prototypeMethods.sort()).toEqual(['constructor', 'isBalanced']);
  });
});
