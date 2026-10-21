import { Inject, Injectable } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { Money } from '../../shared/domain/money';
import { DomainError } from '../../shared/domain/errors';
import { InsufficientFundsError, ReversalWouldOverdrawError } from '../../wallets/domain/errors';
import { Wallet } from '../../wallets/domain/wallet';
import type { LedgerCause } from '../../wallets/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { WALLET_REPOSITORY, type WalletRepository } from '../../wallets/application/ports/wallet-repository';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock-port';
import { ID_GENERATOR, type IdGeneratorPort } from '../../shared/application/ports/id-generator-port';
import { ENTITY_MANAGER } from '../../shared/infrastructure/database/database.module';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { FailureCode } from '../domain/failure-code';
import { canonicalPayloadHash } from './canonical-payload-hash';
import {
  DOMAIN_EVENT_COLLECTOR,
  type DomainEventCollector,
  type WagerTransactionPendingReferenceData,
  type WagerTransactionProcessedData,
  type WagerTransactionRejectedData,
  type WalletBalanceChangedData,
} from './domain-events';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type PendingReferenceSchedule,
  type WagerTransactionRepository,
} from './ports/wager-transaction-repository';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Obrigatório para REFUND/ROLLBACK; opcional para WIN (referencia a BET da rodada). */
  referenceExternalTransactionId?: string | undefined;
}

export interface ExecutionContext {
  source: 'HTTP' | 'SQS';
  inboxMessageId?: string;
}

export type SubmitOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'CONFLICT';

export interface SubmitWagerResult {
  outcome: SubmitOutcome;
  transaction: WagerTransaction;
  /** Saldo após a operação (PROCESSED) ou snapshot original (replay, regra 7.7). */
  balanceAfter: Money | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

/**
 * O ÚNICO use case de submissão — compartilhado por HTTP e SQS (seção 10).
 *
 * Fluxo em UMA transação SQL:
 *  1. SELECT wallet FOR UPDATE (lock pessimista por linha — unidade walletId);
 *  2. INSERT wager_transaction (PENDING) — conflito de idempotência →
 *     re-lê e classifica: mesmo payloadHash → REPLAY (snapshot original,
 *     regra 7.7); hash divergente → IDEMPOTENCY_CONFLICT;
 *  3. validações de domínio (wallet, player, moeda) — falhas viram
 *     REJECTED persistido (determinístico em replays);
 *  4. referência: ausente/não-PROCESSADA → PENDING_REFERENCE (regra 7.8);
 *     presente → valida kind, pertencimento, valor e dupla reversão;
 *  5. aplica: wallet.debit/credit (LOSS não move saldo) → ledger na mesma tx;
 *  6. markProcessed + snapshot de saldo (regra 7.7);
 *  7. eventos coletados no DomainEventCollector (outbox na ET10).
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(DOMAIN_EVENT_COLLECTOR) private readonly events: DomainEventCollector,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async execute(command: SubmitWagerCommand, _context: ExecutionContext): Promise<SubmitWagerResult> {
    const payloadHash = canonicalPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
    });

    return this.em.transactional(async (tx) => {
      // (1) lock pessimista da wallet — a unidade de concorrência é a walletId
      const wallet = await this.wallets.lockById(command.walletId, tx);

      // wallet inexistente: a FK impede persistir a transação; a rejeição é
      // determinística (retry devolve o mesmo resultado). Interpretação
      // documentada: rejeição WALLET_NOT_FOUND não é persistida.
      if (!wallet) {
        const phantom = WagerTransaction.create({
          id: this.ids.newId(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money: command.money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: this.clock.now(),
        });
        return this.reject(null, phantom, FailureCode.WalletNotFound, `wallet ${command.walletId} not found`);
      }

      // (2) INSERT da transação (em savepoint — violação única não aborta a
      // transação externa) + classificação de idempotência
      const transaction = WagerTransaction.create({
        id: this.ids.newId(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
      try {
        await tx.transactional(async (nested) => {
          await this.transactions.insert(transaction, nested);
        });
      } catch (err) {
        if (isIdempotencyUniqueViolation(err)) {
          return this.classifyConflict(tx, command, payloadHash);
        }
        throw err;
      }

      // (3) validações de domínio — REJECTED persistido, nunca exceção
      if (wallet.playerId !== command.playerId) {
        return this.reject(
          tx,
          transaction,
          FailureCode.WalletPlayerMismatch,
          `wallet ${wallet.id} belongs to player ${wallet.playerId}, not ${command.playerId}`,
        );
      }
      if (wallet.currency !== command.money.currency) {
        return this.reject(
          tx,
          transaction,
          FailureCode.CurrencyMismatch,
          `operation currency ${command.money.currency} does not match wallet currency ${wallet.currency}`,
        );
      }

      // (4) resolução de referência (REFUND/ROLLBACK obrigatória; WIN opcional)
      let reference: WagerTransaction | null = null;
      if (transaction.referenceExternalTransactionId !== undefined) {
        const resolved = await this.resolveReference(tx, transaction);
        if (resolved.outcome === 'pending') {
          return resolved.result;
        }
        reference = resolved.reference;
      }

      // (5-7) aplicação + persistência + eventos
      return this.apply(tx, wallet, transaction, reference);
    });
  }

  // ---- idempotência -------------------------------------------------------

  private async classifyConflict(
    tx: EntityManager,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const existing =
      (await this.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey, tx)) ??
      (await this.transactions.findByProviderAndExternalId(command.providerId, command.externalTransactionId, tx));
    if (!existing) {
      throw new DomainError('INFRASTRUCTURE_ERROR', 'idempotency conflict but original transaction not found');
    }
    if (existing.idempotencyKey === command.idempotencyKey && existing.payloadHash === payloadHash) {
      return this.replayResult(existing);
    }
    return {
      outcome: 'CONFLICT',
      transaction: existing,
      balanceAfter: null,
      failureCode: FailureCode.IdempotencyConflict,
      idempotentReplay: false,
    };
  }

  private async replayResult(existing: WagerTransaction): Promise<SubmitWagerResult> {
    const snapshot = await this.transactions.readBalanceSnapshot(existing.id, this.em.fork());
    switch (existing.status) {
      case WagerTransactionStatus.Processed:
        return { outcome: 'PROCESSED', transaction: existing, balanceAfter: snapshot, failureCode: null, idempotentReplay: true };
      case WagerTransactionStatus.Rejected:
        return {
          outcome: 'REJECTED',
          transaction: existing,
          balanceAfter: null,
          failureCode: existing.failureCode ?? null,
          idempotentReplay: true,
        };
      case WagerTransactionStatus.PendingReference:
        return { outcome: 'PENDING_REFERENCE', transaction: existing, balanceAfter: null, failureCode: null, idempotentReplay: true };
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.Failed:
        // inalcançável por construção: insert + processamento são atômicos
        throw new DomainError(
          'INFRASTRUCTURE_ERROR',
          `replayed transaction ${existing.id} is in non-terminal state ${existing.status}`,
        );
    }
  }

  // ---- referências --------------------------------------------------------

  private async resolveReference(
    tx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<{ outcome: 'ok'; reference: WagerTransaction } | { outcome: 'pending'; result: SubmitWagerResult }> {
    const refExternalId = transaction.referenceExternalTransactionId as string;
    const reference = await this.transactions.findReference(transaction.providerId, refExternalId, tx);
    if (!reference || reference.status !== WagerTransactionStatus.Processed) {
      // ausente ou não-PROCESSADA → PENDING_REFERENCE (regra 7.8)
      return { outcome: 'pending', result: await this.pendReference(tx, transaction) };
    }
    if (!isReferenceKindAllowed(transaction.kind, reference.kind)) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceInvalidKind,
          `${transaction.kind} cannot reference ${reference.kind}`),
      };
    }
    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceMismatch,
          'reference does not belong to the same player/wallet/currency/round'),
      };
    }
    // A igualdade de valor vale para REFUND/ROLLBACK (regra 7.5: reversão
    // parcial fora de escopo). WIN referencia a BET mas paga valor próprio.
    if (transaction.requiresReference() && !reference.money.equals(transaction.money)) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceAmountMismatch,
          `amount ${transaction.money.toString()} differs from reference amount ${reference.money.toString()}`),
      };
    }
    if (
      transaction.requiresReference() &&
      (await this.transactions.existsActiveReversal(reference.id, transaction.kind as 'REFUND' | 'ROLLBACK', tx))
    ) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceAlreadyReverted,
          `${transaction.kind} for reference ${refExternalId} already exists in active state`),
      };
    }
    return { outcome: 'ok', reference };
  }

  private async pendReference(tx: EntityManager, transaction: WagerTransaction): Promise<SubmitWagerResult> {
    transaction.markPendingReference();
    const schedule: PendingReferenceSchedule = {
      attempts: 1,
      nextRetryAt: new Date(this.clock.now().getTime() + pendingRefBaseDelayMs()),
    };
    await this.transactions.update(transaction, tx, { pendingReferenceSchedule: schedule });
    const data: WagerTransactionPendingReferenceData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
      attempts: schedule.attempts,
      nextRetryAt: schedule.nextRetryAt.toISOString(),
    };
    this.events.collect({ eventType: 'WagerTransactionPendingReference', aggregateId: transaction.walletId, data });
    return { outcome: 'PENDING_REFERENCE', transaction, balanceAfter: null, failureCode: null, idempotentReplay: false };
  }

  // ---- rejeição e aplicação ------------------------------------------------

  private async reject(
    tx: EntityManager | null,
    transaction: WagerTransaction,
    code: FailureCode,
    _reason: string, // detalhe humano do motivo — logado na ET15 (observabilidade)
  ): Promise<SubmitWagerResult> {
    transaction.reject(code);
    if (tx) {
      await this.transactions.update(transaction, tx);
    }
    const data: WagerTransactionRejectedData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      failureCode: code,
    };
    this.events.collect({ eventType: 'WagerTransactionRejected', aggregateId: transaction.walletId, data });
    return { outcome: 'REJECTED', transaction, balanceAfter: null, failureCode: code, idempotentReplay: false };
  }

  private async apply(
    tx: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | null,
  ): Promise<SubmitWagerResult> {
    if (!transaction.affectsBalance()) {
      // LOSS: registra o resultado sem mover saldo (§7); snapshot do saldo atual
      transaction.markProcessed(reference?.id, this.clock.now());
      await this.transactions.update(transaction, tx, { balanceSnapshot: wallet.balance });
      this.collectProcessed(transaction);
      return { outcome: 'PROCESSED', transaction, balanceAfter: wallet.balance, failureCode: null, idempotentReplay: false };
    }

    const direction = transaction.ledgerDirectionFor(reference ?? undefined);
    const meta = {
      transactionId: transaction.id,
      entryId: this.ids.newId(),
      cause: toLedgerCause(transaction.kind),
      at: this.clock.now(),
    };
    let entry: WalletLedgerEntry;
    try {
      if (direction === LedgerDirection.Debit) {
        entry = wallet.debit(transaction.money, meta).entry;
      } else if (direction === LedgerDirection.Credit) {
        entry = wallet.credit(transaction.money, meta).entry;
      } else {
        throw new DomainError('INFRASTRUCTURE_ERROR', `no ledger direction for ${transaction.kind}`);
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return this.reject(tx, transaction, FailureCode.InsufficientFunds, err.message);
      }
      if (err instanceof ReversalWouldOverdrawError) {
        return this.reject(tx, transaction, FailureCode.ReversalWouldOverdraw, err.message);
      }
      throw err;
    }

    // saldo + ledger na MESMA transação (invariante §6.2)
    await this.wallets.update(wallet, tx);

    transaction.markProcessed(reference?.id, this.clock.now());
    await this.transactions.update(transaction, tx, { balanceSnapshot: wallet.balance });

    this.collectProcessed(transaction);
    this.collectBalanceChanged(wallet, transaction, entry, direction);
    return { outcome: 'PROCESSED', transaction, balanceAfter: wallet.balance, failureCode: null, idempotentReplay: false };
  }

  private collectProcessed(transaction: WagerTransaction): void {
    const data: WagerTransactionProcessedData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      processedAt: (transaction.processedAt ?? this.clock.now()).toISOString(),
    };
    this.events.collect({ eventType: 'WagerTransactionProcessed', aggregateId: transaction.walletId, data });
  }

  private collectBalanceChanged(
    wallet: Wallet,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry,
    direction: LedgerDirection,
  ): void {
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money: transaction.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    };
    this.events.collect({ eventType: 'WalletBalanceChanged', aggregateId: wallet.id, data });
  }
}

function toLedgerCause(kind: WagerTransactionKind): LedgerCause {
  switch (kind) {
    case WagerTransactionKind.Bet: return 'BET';
    case WagerTransactionKind.Win: return 'WIN';
    case WagerTransactionKind.Loss: return 'LOSS';
    case WagerTransactionKind.Refund: return 'REFUND';
    case WagerTransactionKind.Rollback: return 'ROLLBACK';
    case WagerTransactionKind.Opening: return 'OPENING';
  }
}

function isReferenceKindAllowed(kind: WagerTransactionKind, referenceKind: WagerTransactionKind): boolean {
  switch (kind) {
    case WagerTransactionKind.Refund:
      return referenceKind === WagerTransactionKind.Bet;
    case WagerTransactionKind.Rollback:
      return (
        referenceKind === WagerTransactionKind.Bet ||
        referenceKind === WagerTransactionKind.Win ||
        referenceKind === WagerTransactionKind.Refund
      );
    case WagerTransactionKind.Win:
      return referenceKind === WagerTransactionKind.Bet;
    default:
      return false;
  }
}

function pendingRefBaseDelayMs(): number {
  const parsed = Number.parseInt(process.env.PENDING_REF_BASE_DELAY_MS ?? '5000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

type UniqueViolation = { code?: string; constraint?: string; message?: string };

function isIdempotencyUniqueViolation(err: unknown): boolean {
  const e = err as UniqueViolation;
  if (e?.code !== '23505') return false;
  return (
    (e?.constraint?.startsWith('uq_tx_') ?? false) ||
    (e?.message?.includes('uq_tx_idempotency') ?? false) ||
    (e?.message?.includes('uq_tx_external') ?? false)
  );
}
