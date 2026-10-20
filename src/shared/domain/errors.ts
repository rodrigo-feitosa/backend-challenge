/**
 * Hierarquia de erros de domínio (shared).
 * Erros de domínio carregam um `code` estável e legível por máquina
 * (requisito da seção 7.2 do desafio) — usado para mapear respostas
 * HTTP, failureCodes e eventos sem interpretar mensagens.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada monetária inválida (formato, escala, tipo). Permanente. */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('AMOUNT_INVALID', message);
  }
}

/** Operação entre moedas diferentes. Permanente. */
export class CurrencyMismatchError extends DomainError {
  constructor(message: string) {
    super('CURRENCY_MISMATCH', message);
  }
}
