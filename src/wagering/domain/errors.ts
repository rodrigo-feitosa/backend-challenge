import { DomainError } from '../../shared/domain/errors';

/**
 * Tentativa de transicionar uma transação em estado terminal
 * (PROCESSED/REJECTED/FAILED) — erro de programação, não caminho de negócio.
 */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
  }
}

/**
 * Transação inválida na criação (payload não passa nas regras do domínio).
 */
export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}
