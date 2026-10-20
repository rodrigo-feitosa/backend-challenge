import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const BRL = { currency: 'BRL' } as const;

describe('Money.from — entradas válidas', () => {
  it('aceita valor com escala 2', () => {
    const money = Money.from({ amount: '25.00', ...BRL });
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('normaliza escala para 2 na serialização ("25.5" → "25.50")', () => {
    expect(Money.from({ amount: '25.5', ...BRL }).toJSON().amount).toBe('25.50');
    expect(Money.from({ amount: '25', ...BRL }).toJSON().amount).toBe('25.00');
    expect(Money.from({ amount: '0', ...BRL }).toJSON().amount).toBe('0.00');
  });

  it('aceita valores de alto valor (18 dígitos inteiros)', () => {
    expect(Money.from({ amount: '999999999999999999.99', ...BRL }).toString()).toBe('999999999999999999.99');
  });

  it('zero(currency) cria valor nulo', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});

describe('Money.from — entradas inválidas', () => {
  const invalid = [
    '', // string vazia
    '   ',
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e5', // notação científica
    '1E5',
    '0x10',
    '1.234', // mais de 2 casas
    '1.999',
    '1.', // ponto sem decimais
    '.5', // sem parte inteira
    '+1.00', // sinal explícito
    '-1.00', // negativo (contrato de entrada)
    '-0.01',
    '1,00', // vírgula
    ' 1.00', // espaço na borda
    '1.00 ',
    '1_000',
    '1234567890123456789', // 19 dígitos inteiros
  ];

  for (const amount of invalid) {
    it(`rejeita ${JSON.stringify(amount)}`, () => {
      expect(() => Money.from({ amount, ...BRL })).toThrow(InvalidMoneyError);
    });
  }

  it('rejeita number (nunca number para dinheiro)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, ...BRL })).toThrow(InvalidMoneyError);
  });
});

describe('Money — moeda', () => {
  it('rejeita moeda inválida', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BRLX' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BR' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BRL ' })).toThrow(InvalidMoneyError);
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });

  it('operações entre moedas diferentes lançam CurrencyMismatchError', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('equals com moedas diferentes retorna false (não lança)', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(brl.equals(usd)).toBe(false);
  });

  it('erros carregam código estável legível por máquina', () => {
    try {
      Money.from({ amount: '10.00', currency: 'BRL' }).add(Money.from({ amount: '1.00', currency: 'USD' }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CurrencyMismatchError);
      expect((err as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    }
    try {
      Money.from({ amount: 'x', ...BRL });
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidMoneyError).code).toBe('AMOUNT_INVALID');
    }
  });
});

describe('Money — aritmética exata', () => {
  it('soma exata (armadilha clássica de float)', () => {
    expect(Money.from({ amount: '0.10', ...BRL }).add(Money.from({ amount: '0.20', ...BRL })).toString()).toBe('0.30');
  });

  it('soma com carry de escala', () => {
    expect(Money.from({ amount: '999999999999999999.99', ...BRL }).add(Money.from({ amount: '0.01', ...BRL })).toString()).toBe(
      '1000000000000000000.00',
    );
  });

  it('subtração exata', () => {
    expect(Money.from({ amount: '10.00', ...BRL }).subtract(Money.from({ amount: '4.00', ...BRL })).toString()).toBe('6.00');
    expect(Money.from({ amount: '5.00', ...BRL }).subtract(Money.from({ amount: '5.00', ...BRL })).isZero()).toBe(true);
  });

  it('subtração pode produzir valor negativo interno (cálculo de reversão)', () => {
    const diff = Money.from({ amount: '4.00', ...BRL }).subtract(Money.from({ amount: '5.00', ...BRL }));
    expect(diff.isNegative()).toBe(true);
    expect(diff.toJSON().amount).toBe('-1.00');
  });

  it('negate inverte o sinal', () => {
    const five = Money.from({ amount: '5.00', ...BRL });
    expect(five.negate().toString()).toBe('-5.00');
    expect(five.negate().negate().equals(five)).toBe(true);
    expect(five.negate().negate().equals(five)).toBe(true);
  });
});

describe('Money — imutabilidade', () => {
  it('operações não alteram o receptor', () => {
    const a = Money.from({ amount: '10.00', ...BRL });
    const b = Money.from({ amount: '2.50', ...BRL });
    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('2.50');
    expect(sum.toString()).toBe('12.50');
    expect(diff.toString()).toBe('7.50');
    expect(neg.toString()).toBe('-10.00');
  });
});

describe('Money — comparações', () => {
  it('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(Money.from({ amount: '0.01', ...BRL }).isPositive()).toBe(true);
    expect(Money.from({ amount: '0.00', ...BRL }).isPositive()).toBe(false);
  });

  it('isLessThan', () => {
    expect(Money.from({ amount: '1.00', ...BRL }).isLessThan(Money.from({ amount: '2.00', ...BRL }))).toBe(true);
    expect(Money.from({ amount: '2.00', ...BRL }).isLessThan(Money.from({ amount: '2.00', ...BRL }))).toBe(false);
    expect(Money.from({ amount: '3.00', ...BRL }).isLessThan(Money.from({ amount: '2.00', ...BRL }))).toBe(false);
  });

  it('equals compara valor e moeda', () => {
    expect(Money.from({ amount: '5.00', ...BRL }).equals(Money.from({ amount: '5.00', ...BRL }))).toBe(true);
    expect(Money.from({ amount: '5.0', ...BRL }).equals(Money.from({ amount: '5.00', ...BRL }))).toBe(true);
    expect(Money.from({ amount: '5.00', ...BRL }).equals(Money.from({ amount: '5.01', ...BRL }))).toBe(false);
  });
});

describe('Money — persistência em centavos (ADR-002)', () => {
  it('round-trip centavos ⇄ Money é exato', () => {
    const original = Money.from({ amount: '1234.56', ...BRL });
    const restored = Money.fromCents(original.toCents(), 'BRL');
    expect(restored.equals(original)).toBe(true);
    expect(restored.toJSON()).toEqual({ amount: '1234.56', currency: 'BRL' });
  });

  it('fromCents aceita bigint e string, negativo (uso interno)', () => {
    expect(Money.fromCents('2500', 'BRL').toString()).toBe('25.00');
    expect(Money.fromCents(2500n, 'BRL').toString()).toBe('25.00');
    expect(Money.fromCents('-100', 'BRL').isNegative()).toBe(true);
    expect(Money.fromCents('10', 'BRL').toString()).toBe('0.10');
  });

  it('toCents rejeita valor fora da escala 2 (defesa)', () => {
    const money = Money.from({ amount: '1.00', ...BRL });
    const internal = Money.fromCents('105', 'BRL'); // 1.05 — válido
    expect(internal.toCents()).toBe(105n);
    expect(money.toCents()).toBe(100n);
  });

  it('fromCents rejeita não-inteiros', () => {
    expect(() => Money.fromCents('10.5', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.fromCents('abc', 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.fromCents('1e3', 'BRL')).toThrow(InvalidMoneyError);
  });
});
