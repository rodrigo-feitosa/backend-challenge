import { createHash } from 'node:crypto';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (regra 7.8). */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Rejeitada por regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/**
 * Máquina de estados (§6.3 do desafio):
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *
 *   PROCESSED | REJECTED | FAILED: TERMINAIS — qualquer transição a partir
 *   deles é InvalidTransactionStateError (erro de programação).
 *   PENDING_REFERENCE ──► PENDING_REFERENCE é idempotente (no-op).
 */

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno (regra 7.1). */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertNonEmpty('id', props.id);
    assertNonEmpty('providerId', props.providerId);
    assertNonEmpty('externalTransactionId', props.externalTransactionId);
    assertNonEmpty('idempotencyKey', props.idempotencyKey);
    assertNonEmpty('payloadHash', props.payloadHash);
    assertNonEmpty('walletId', props.walletId);
    assertNonEmpty('playerId', props.playerId);
    assertNonEmpty('roundId', props.roundId);
    assertNonEmpty('gameId', props.gameId);
    if (!(props.createdAt instanceof Date) || Number.isNaN(props.createdAt.getTime())) {
      throw new InvalidWagerTransactionError('createdAt must be a valid Date');
    }

    // OPENING é interno: nunca submetível pela API nem pela fila (§6.3).
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('kind OPENING is internal and cannot be submitted');
    }

    // Valor positivo: aposta de valor zero não tem sentido e o ledger exige > 0.
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('transaction amount must be positive');
    }

    const hasReference = props.referenceExternalTransactionId !== undefined && props.referenceExternalTransactionId !== '';
    if (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) {
      if (!hasReference) {
        throw new InvalidWagerTransactionError(`kind ${props.kind} requires referenceExternalTransactionId (rule 7.1)`);
      }
    } else if (hasReference && props.kind !== WagerTransactionKind.Win) {
      // WIN pode referenciar a BET da rodada (§7); BET/LOSS não carregam referência.
      throw new InvalidWagerTransactionError(`kind ${props.kind} must not carry a reference`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      hasReference ? props.referenceExternalTransactionId : undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );
  }

  /**
   * Fábrica interna: OPENING é criado pelo OpenWalletUseCase (crédito de
   * abertura da wallet) — nunca submetível por API ou fila. Nasce já
   * PROCESSED, com provider 'internal' (restrição do schema).
   */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    amount: Money;
    createdAt: Date;
  }): WagerTransaction {
    const externalId = `opening:${props.walletId}`;
    const payloadHash = createHash('sha256')
      .update(`OPENING|${props.walletId}|${props.amount.toCents()}|${props.amount.currency}`, 'utf8')
      .digest('hex');
    return new WagerTransaction(
      props.id,
      'internal',
      externalId,
      externalId,
      payloadHash,
      props.walletId,
      props.playerId,
      '', // OPENING não pertence a uma rodada
      '', // nem a um jogo
      WagerTransactionKind.Opening,
      props.amount,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.createdAt,
    );
  }

  /** Reconstrução a partir da persistência — NÃO revalida transições [S6.0]. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (InvalidTransactionStateError se o estado for terminal) ----

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertTransitionAllowed('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertTransitionAllowed('markPendingReference');
    if (this._status === WagerTransactionStatus.PendingReference) {
      return; // idempotente — reprocessamento que continua sem referência
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertTransitionAllowed('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertTransitionAllowed('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio ----

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** false para LOSS (§7: registra o resultado sem mover saldo). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK (regra 7.1). */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger:
   * - BET → DEBIT; WIN/REFUND → CREDIT; LOSS → sem lançamento;
   * - ROLLBACK inverte a referência: ref=BET → CREDIT (desfaz débito);
   *   ref=WIN|REFUND → DEBIT (desfaz crédito).
   * Exige a referência resolvida para ROLLBACK.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK requires the resolved reference to determine ledger direction');
        }
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
    }
  }

  private assertTransitionAllowed(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation} on transaction ${this.id} in terminal state ${this._status}`,
      );
    }
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWagerTransactionError(`${field} must be a non-empty string`);
  }
}
