import { DomainError } from '../../shared/domain/errors';

/**
 * Saldo insuficiente para um débito de aposta (BET) — código estável
 * da taxonomia ADR-010. O provedor decide: reenviar após créditos ou desistir.
 */
export class InsufficientFundsError extends DomainError {
  constructor(message: string) {
    super('INSUFFICIENT_FUNDS', message);
  }
}

/**
 * Reversão (ROLLBACK de WIN/REFUND) deixaria o saldo negativo — código
 * DISTINTO do de aposta sem saldo (regra 7.9 do desafio: situações
 * operacionalmente diferentes).
 */
export class ReversalWouldOverdrawError extends DomainError {
  constructor(message: string) {
    super('REVERSAL_WOULD_OVERDRAW', message);
  }
}
