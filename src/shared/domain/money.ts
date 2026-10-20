import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/**
 * Configuração global do Decimal: precisão 20 dígitos cobre os máximos do
 * domínio (18 dígitos inteiros + 2 decimais). Nenhuma operação usada aqui
 * (soma, subtração, negação) arredonda — os valores são exatos por construção.
 */
Decimal.set({ precision: 20 });

/** DTO de entrada/saída — amount é sempre string decimal com escala ≤ 2. */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

/**
 * Formato aceito na ENTRADA (contratos de API/fila):
 * - apenas dígitos, opcional 1-2 decimais;
 * - rejeita vazio, espaços, notação científica, "NaN", "Infinity",
 *   mais de 2 casas, sinal "+", vírgula e negativos (contrato de entrada);
 * - até 18 dígitos inteiros.
 * A serialização interna de instâncias calculadas pode ser negativa
 * (ex.: resultado de `subtract`/`negate` usado em regras de reversão);
 * valores negativos nunca são aceitos como entrada nem persistidos como saldo.
 */
const AMOUNT_PATTERN = /^-?\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value Object monetário imutável e exato [R5.1] — jamais `number`.
 * Toda operação retorna uma nova instância; o valor só é exposto como
 * string decimal (escala fixa 2 na serialização).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Fábrica validada — única entrada de valores externos ao domínio. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `amount must be a decimal string with up to 2 fraction digits, got: ${describe(props.amount)}`,
      );
    }
    if (props.amount.startsWith('-')) {
      throw new InvalidMoneyError('amount must not be negative (input contract)');
    }
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(
        `currency must be an ISO-4217 code (3 uppercase letters), got: ${describe(props.currency)}`,
      );
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency must be an ISO-4217 code (3 uppercase letters), got: ${describe(currency)}`);
    }
    return new Money(new Decimal(0), currency);
  }

  /**
   * Reconstrução a partir de centavos (persistência — MoneyType, ADR-002).
   * Centavos são bigint exatos; a conversão string→Decimal é exata.
   * Não é entrada de contrato externo — usado apenas pelo mapper de persistência.
   */
  static fromCents(cents: string | bigint, currency: string): Money {
    const centsStr = typeof cents === 'bigint' ? cents.toString() : cents;
    if (!/^-?\d+$/.test(centsStr)) {
      throw new InvalidMoneyError(`cents must be an integer string, got: ${describe(centsStr)}`);
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency must be an ISO-4217 code (3 uppercase letters), got: ${describe(currency)}`);
    }
    return new Money(new Decimal(centsStr).dividedBy(100), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  /** Uso interno para cálculo de reversão — não é caminho de entrada. */
  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  /** Comparação de valor e moeda — não lança em moedas diferentes. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  /**
   * Valor em centavos (bigint) para persistência exata (ADR-002).
   * Falha se a escala interna exceder 2 — nunca deve ocorrer: toda
   * instância nasce de entrada validada ou de operação exata entre elas.
   */
  toCents(): bigint {
    const cents = this.value.times(100);
    if (!cents.isInteger()) {
      throw new InvalidMoneyError(`internal invariant violated: value ${this.toString()} exceeds scale 2`);
    }
    return BigInt(cents.toFixed(0));
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `operation requires same currency: ${this.currency} !== ${other.currency}`,
      );
    }
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
