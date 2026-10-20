/**
 * Taxonomia de falhas (seção 7.2 do desafio / ADR-010 do plano).
 *
 * Cada código é estável, legível por máquina e carrega a SEMÂNTICA DE RETRY —
 * suficiente para o provedor decidir entre: reenviar, corrigir o payload
 * ou desistir. Os códigos são expostos na API (failureCode) e nos eventos
 * de integração (WagerTransactionRejected.data.failureCode).
 */
export enum FailureCode {
  /** Payload inválido (permanente). Provedor deve: corrigir o payload. */
  ValidationError = 'VALIDATION_ERROR',

  /** Valor fora de formato/escala/positivo (permanente). Provedor deve: corrigir o payload. */
  AmountInvalid = 'AMOUNT_INVALID',

  /** Mesma idempotency key com payload divergente (permanente). Provedor deve: NÃO reenviar com essa key. */
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',

  /** Moeda ≠ moeda da wallet (permanente). Provedor deve: corrigir o payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  /** Wallet/player inexistente (permanente). Provedor deve: não reenviar sem criar a wallet. */
  WalletNotFound = 'WALLET_NOT_FOUND',

  /** walletId não pertence ao playerId (permanente). Provedor deve: corrigir o payload. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',

  /** Saldo insuficiente para BET (negócio). Provedor decide: reenviar após créditos ou desistir. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',

  /**
   * Reversão deixaria o saldo negativo (negócio) — código DISTINTO de
   * INSUFFICIENT_FUNDS (regra 7.9: situações operacionalmente diferentes).
   * Provedor deve: investigar a referência; não reenviar cegamente.
   */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',

  /** Referência inexistente após TTL (regra 7.1, terminal). Provedor deve: reenviar a referência primeiro. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',

  /** REFUND→BET / ROLLBACK→(BET,WIN,REFUND) violado (permanente). Provedor deve: corrigir a referência. */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',

  /** Referência de outro provider/player/wallet/moeda/rodada (permanente). Provedor deve: corrigir a referência. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',

  /** Valor ≠ valor da referência (permanente). Provedor deve: corrigir o valor. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  /** Referência já revertida por esse tipo de operação (negócio). Provedor deve: não reenviar. */
  ReferenceAlreadyReverted = 'REFERENCE_ALREADY_REVERTED',

  /** PENDING_REFERENCE esgotou tentativas/TTL (terminal). Provedor deve: reprocessar a cadeia. */
  ReferenceTtlExpired = 'REFERENCE_TTL_EXPIRED',

  /**
   * Erro transitório de infraestrutura — NÃO vira status REJECTED: a
   * mensagem volta para a fila (retry). Provedor deve: reenviar/reprocessar.
   */
  InfrastructureError = 'INFRASTRUCTURE_ERROR',
}
