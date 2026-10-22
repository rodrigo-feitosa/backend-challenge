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
import { OUTBOX_REPOSITORY, type OutboxRepository } from '../../messaging/application/ports/outbox-repository';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import { WagerTransactionProcessed } from '../../messaging/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../messaging/domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../messaging/domain/events/wager-transaction-pending-reference';
import { WalletBalanceChanged } from '../../messaging/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { INBOX_REPOSITORY, type InboxRepository } from '../../messaging/application/ports/inbox-repository';
import { createLogger } from '../../shared/infrastructure/logging/logger';
import { runWithCorrelation, updateCorrelation } from '../../shared/infrastructure/logging/correlation';
import { metrics } from '../../shared/infrastructure/metrics/metrics';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type PendingReferenceSchedule,
  type WagerTransactionRepository,
} from './ports/wager-transaction-repository';

const log = createLogger('submit-wager');

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
  /** Correlação: header X-Correlation-ID (HTTP) ou messageId (SQS). */
  correlationId: string;
  /** Presente no canal SQS: deduplicação persistente na mesma transação (§10). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}

export type SubmitOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'CONFLICT' | 'DUPLICATE';

export interface SubmitWagerResult {
  outcome: SubmitOutcome;
  /** null para DUPLICATE (nenhum processamento novo ocorreu). */
  transaction: WagerTransaction | null;
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
 *  7. eventos gravados na outbox na mesma transação.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async execute(command: SubmitWagerCommand, context: ExecutionContext): Promise<SubmitWagerResult> {
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
    const correlationId = context.correlationId || this.ids.newId();
    const channel = context.source.toLowerCase();
    const startedAt = Date.now();

    // todo log daqui pra baixo carrega os identificadores automaticamente
    return runWithCorrelation(
      { correlationId, providerId: command.providerId, walletId: command.walletId, messageId: context.inbox?.messageId },
      async () => {
        try {
          const result = await this.em.fork().transactional(async (tx) => {
            const outcome = await this.process(command, context, payloadHash, correlationId, tx);
            updateCorrelation({ transactionId: outcome.transaction?.id });
            return outcome;
          });
          metrics.incTransaction(result.outcome, command.providerId, command.kind);
          if (result.outcome === 'DUPLICATE' || result.idempotentReplay) {
            metrics.incDuplicate(channel);
          }
          return result;
        } finally {
          metrics.observeProcessingLatency(channel, (Date.now() - startedAt) / 1000);
        }
      },
    );
  }

  private async process(
    command: SubmitWagerCommand,
    context: ExecutionContext,
    payloadHash: string,
    correlationId: string,
    tx: EntityManager,
  ): Promise<SubmitWagerResult> {
      // (0) canal SQS: deduplicação persistente NA MESMA transação (§10).
      // Linha existe ⇒ mensagem já processada; rollback remove a linha.
      if (context.inbox) {
        const record = InboxMessage.receive({
          id: this.ids.newId(),
          messageId: context.inbox.messageId,
          consumerName: context.inbox.consumerName,
          payloadHash: context.inbox.payloadHash,
          receivedAt: this.clock.now(),
        });
        record.markProcessed(this.clock.now()); // simplificação: "existe" ⇒ "processada"
        try {
          await tx.transactional(async (nested) => {
            await this.inbox.insert(record, nested);
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            return { outcome: 'DUPLICATE' as const, transaction: null, balanceAfter: null, failureCode: null, idempotentReplay: true };
          }
          throw err;
        }
      }

      // (1) lock pessimista da wallet — a unidade de concorrência é a walletId
      const lockStartedAt = Date.now();
      const wallet = await this.wallets.lockById(command.walletId, tx);
      metrics.observeLockWait((Date.now() - lockStartedAt) / 1000);

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
        phantom.reject(FailureCode.WalletNotFound);
        // a transação não é persistida (FK), mas o evento de rejeição vai
        // para a outbox (não tem FK) — rastreável
        await this.emit(tx, WagerTransactionRejected.from(phantom, this.eventCtx(correlationId, phantom)));
        return { outcome: 'REJECTED', transaction: phantom, balanceAfter: null, failureCode: FailureCode.WalletNotFound, idempotentReplay: false };
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
      updateCorrelation({ transactionId: transaction.id });
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
          correlationId,
        );
      }
      if (wallet.currency !== command.money.currency) {
        return this.reject(
          tx,
          transaction,
          FailureCode.CurrencyMismatch,
          `operation currency ${command.money.currency} does not match wallet currency ${wallet.currency}`,
          correlationId,
        );
      }

      // (4) resolução de referência (REFUND/ROLLBACK obrigatória; WIN opcional)
      let reference: WagerTransaction | null = null;
      if (transaction.referenceExternalTransactionId !== undefined) {
        const resolved = await this.resolveReference(tx, transaction, correlationId);
        if (resolved.outcome === 'pending') {
          return resolved.result;
        }
        reference = resolved.reference;
      }

      // (5-7) aplicação + persistência + eventos
      return this.apply(tx, wallet, transaction, reference, correlationId);
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
      return this.replayResult(existing, tx);
    }
    return {
      outcome: 'CONFLICT',
      transaction: existing,
      balanceAfter: null,
      failureCode: FailureCode.IdempotencyConflict,
      idempotentReplay: false,
    };
  }

  private async replayResult(existing: WagerTransaction, tx: EntityManager): Promise<SubmitWagerResult> {
    // usa a conexão transacional: um fork extra aqui esgotaria o pool sob
    // concorrência (deadlock de pool — transações esperando 2ª conexão)
    const snapshot = await this.transactions.readBalanceSnapshot(existing.id, tx);
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
    correlationId: string,
    options: { reschedule?: boolean } = {},
  ): Promise<{ outcome: 'ok'; reference: WagerTransaction } | { outcome: 'pending'; result: SubmitWagerResult }> {
    const refExternalId = transaction.referenceExternalTransactionId as string;
    const reference = await this.transactions.findReference(transaction.providerId, refExternalId, tx);
    if (!reference || reference.status !== WagerTransactionStatus.Processed) {
      // ausente ou não-PROCESSADA → PENDING_REFERENCE (regra 7.8)
      return { outcome: 'pending', result: await this.pendReference(tx, transaction, correlationId, options.reschedule !== false) };
    }
    if (!isReferenceKindAllowed(transaction.kind, reference.kind)) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceInvalidKind,
          `${transaction.kind} cannot reference ${reference.kind}`, correlationId),
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
          'reference does not belong to the same player/wallet/currency/round', correlationId),
      };
    }
    // A igualdade de valor vale para REFUND/ROLLBACK (regra 7.5: reversão
    // parcial fora de escopo). WIN referencia a BET mas paga valor próprio.
    if (transaction.requiresReference() && !reference.money.equals(transaction.money)) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceAmountMismatch,
          `amount ${transaction.money.toString()} differs from reference amount ${reference.money.toString()}`, correlationId),
      };
    }
    if (
      transaction.requiresReference() &&
      (await this.transactions.existsActiveReversal(reference.id, transaction.kind as 'REFUND' | 'ROLLBACK', tx))
    ) {
      return {
        outcome: 'pending',
        result: await this.reject(tx, transaction, FailureCode.ReferenceAlreadyReverted,
          `${transaction.kind} for reference ${refExternalId} already exists in active state`, correlationId),
      };
    }
    return { outcome: 'ok', reference };
  }

  private async pendReference(
    tx: EntityManager,
    transaction: WagerTransaction,
    correlationId: string,
    reschedule: boolean,
  ): Promise<SubmitWagerResult> {
    transaction.markPendingReference();
    if (reschedule) {
      const schedule: PendingReferenceSchedule = {
        attempts: 1,
        nextRetryAt: new Date(this.clock.now().getTime() + pendingRefBaseDelayMs()),
      };
      await this.transactions.update(transaction, tx, { pendingReferenceSchedule: schedule });
      await this.emit(tx, WagerTransactionPendingReference.from(transaction, schedule, this.eventCtx(correlationId, transaction)));
    }
    // retry do worker (reschedule=false): sem evento e sem reset do agendamento —
    // o worker é dono de attempts/next_retry_at
    return { outcome: 'PENDING_REFERENCE', transaction, balanceAfter: null, failureCode: null, idempotentReplay: false };
  }

  /**
   * Reprocessamento de uma PENDING_REFERENCE pelo worker (7.1).
   * Reexecuta apenas a resolução/aplicação — a contagem de tentativas e o
   * agendamento são responsabilidade do worker.
   */
  async retryPendingReference(transactionId: string, correlationId: string): Promise<SubmitWagerResult> {
    return this.em.fork().transactional(async (tx) => {
      const transaction = await this.transactions.lockById(transactionId, tx);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        // outra instância já tratou
        return { outcome: 'PROCESSED', transaction, balanceAfter: null, failureCode: null, idempotentReplay: true };
      }
      const wallet = await this.wallets.lockById(transaction.walletId, tx);
      if (!wallet) {
        throw new DomainError('INFRASTRUCTURE_ERROR', `wallet ${transaction.walletId} disappeared for pending reference ${transactionId}`);
      }
      const resolved = await this.resolveReference(tx, transaction, correlationId, { reschedule: false });
      if (resolved.outcome === 'pending') {
        return resolved.result;
      }
      return this.apply(tx, wallet, transaction, resolved.reference, correlationId);
    });
  }

  /** Esgotadas as tentativas/TTL (7.1): rejeição terminal com REFERENCE_NOT_FOUND. */
  async rejectPendingReference(transactionId: string, correlationId: string): Promise<void> {
    await this.em.fork().transactional(async (tx) => {
      const transaction = await this.transactions.lockById(transactionId, tx);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return; // outra instância já tratou
      }
      await this.reject(tx, transaction, FailureCode.ReferenceNotFound, 'reference not found within retry budget', correlationId);
    });
  }

  // ---- rejeição e aplicação ------------------------------------------------

  private async reject(
    tx: EntityManager,
    transaction: WagerTransaction,
    code: FailureCode,
    _reason: string, // NÃO logado: motivos podem conter valores financeiros [S12];
    // a causa fica registrada pelo failureCode (máquina) e pelo evento
    correlationId: string,
  ): Promise<SubmitWagerResult> {
    log.warn(
      {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        kind: transaction.kind,
        failureCode: code,
      },
      'transaction rejected',
    );
    transaction.reject(code);
    await this.transactions.update(transaction, tx);
    await this.emit(tx, WagerTransactionRejected.from(transaction, this.eventCtx(correlationId, transaction)));
    return { outcome: 'REJECTED', transaction, balanceAfter: null, failureCode: code, idempotentReplay: false };
  }

  private async apply(
    tx: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | null,
    correlationId: string,
  ): Promise<SubmitWagerResult> {
    if (!transaction.affectsBalance()) {
      // LOSS: registra o resultado sem mover saldo (§7); snapshot do saldo atual
      transaction.markProcessed(reference?.id, this.clock.now());
      await this.transactions.update(transaction, tx, { balanceSnapshot: wallet.balance });
      await this.emit(tx, WagerTransactionProcessed.from(transaction, this.eventCtx(correlationId, transaction)));
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
        return this.reject(tx, transaction, FailureCode.InsufficientFunds, err.message, correlationId);
      }
      if (err instanceof ReversalWouldOverdrawError) {
        return this.reject(tx, transaction, FailureCode.ReversalWouldOverdraw, err.message, correlationId);
      }
      throw err;
    }

    // saldo + ledger na MESMA transação (invariante §6.2); CAS como segunda
    // barreira de concorrência (ADR-003): só aplica se o saldo no banco
    // ainda for o que lemos sob o lock
    try {
      await this.wallets.update(wallet, tx, { expectedBalanceCents: entry.balanceBefore.toCents() });
    } catch (err) {
      if (err instanceof DomainError && err.message.includes('CAS mismatch')) {
        metrics.incLockConflict();
      }
      throw err;
    }

    transaction.markProcessed(reference?.id, this.clock.now());
    await this.transactions.update(transaction, tx, { balanceSnapshot: wallet.balance });

    // cada evento tem seu próprio eventId/occurredAt (PK da outbox é o eventId)
    await this.emit(tx, WagerTransactionProcessed.from(transaction, this.eventCtx(correlationId, transaction)));
    await this.emit(tx, WalletBalanceChanged.from(wallet, entry, this.eventCtx(correlationId, transaction)));
    return { outcome: 'PROCESSED', transaction, balanceAfter: wallet.balance, failureCode: null, idempotentReplay: false };
  }

  /** Evento → OutboxMessage → mesma transação SQL (§11). */
  private async emit(tx: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    await this.outbox.enqueue(OutboxMessage.enqueue(event), tx);
  }

  private eventCtx(correlationId: string, transaction: WagerTransaction): EventContext {
    return {
      eventId: this.ids.newId(),
      aggregateId: transaction.walletId,
      correlationId,
      causationId: transaction.id,
      occurredAt: this.clock.now(),
    };
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

/** Qualquer violação de UNIQUE (usado pela inbox). */
function isUniqueViolation(err: unknown): boolean {
  return (err as UniqueViolation)?.code === '23505';
}

function isIdempotencyUniqueViolation(err: unknown): boolean {
  const e = err as UniqueViolation;
  if (e?.code !== '23505') return false;
  return (
    (e?.constraint?.startsWith('uq_tx_') ?? false) ||
    (e?.message?.includes('uq_tx_idempotency') ?? false) ||
    (e?.message?.includes('uq_tx_external') ?? false)
  );
}
