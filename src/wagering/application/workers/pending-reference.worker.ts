import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { createLogger } from '../../../shared/infrastructure/logging/logger';
import { CLOCK, type ClockPort } from '../../../shared/application/ports/clock-port';
import { ENTITY_MANAGER } from '../../../shared/infrastructure/database/database.module';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../ports/wager-transaction-repository';
import { SubmitWagerTransactionUseCase } from '../submit-wager-transaction.use-case';
import { metrics } from '../../../shared/infrastructure/metrics/metrics';

const log = createLogger('pending-reference');

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Backoff 5s × 2^(n-1), teto 5min (ADR do plano, seção 3.3). */
function backoffMs(attempts: number): number {
  return Math.min(5000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/**
 * Worker de PENDING_REFERENCE (regra 7.1): reprocessa transações cuja
 * referência estava ausente. Executa em todas as instâncias — o lock da
 * linha da transação serializa; tentativas e agendamento são dono deste
 * worker (attempts via incremento atômico, next_retry_at via backoff).
 * Esgotado o limite de tentativas ou o TTL → REJECTED (REFERENCE_NOT_FOUND)
 * + evento, permanecendo auditável.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    private readonly useCase: SubmitWagerTransactionUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') {
      log.info('pending-reference worker disabled (WORKERS_ENABLED=false)');
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, envInt('PENDING_REF_POLL_INTERVAL_MS', 5000));
    log.info('pending-reference worker started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const due = await this.transactions.findPendingReferenceDue(envInt('PENDING_REF_BATCH_SIZE', 20), this.em.fork());
      for (const transaction of due) {
        if (!this.running) return;
        await this.processOne(transaction.id);
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'pending-reference sweep failed');
    }
  }

  private async processOne(transactionId: string): Promise<void> {
    try {
      const result = await this.useCase.retryPendingReference(transactionId, `pending-ref:${transactionId}`);
      if (result.outcome === 'PROCESSED' || result.outcome === 'REJECTED') {
        return; // terminal: aplicada ou rejeitada por regra (ex.: referência inválida)
      }

      // ainda pendente: contabiliza tentativa e agenda/limita
      const attempts = await this.transactions.incrementPendingReferenceAttempt(transactionId, this.em.fork());
      if (attempts === null) return; // deixou de ser PENDING_REFERENCE nesse meio-tempo
      metrics.incRetry('pending_reference');

      const maxAttempts = envInt('PENDING_REF_MAX_ATTEMPTS', 10);
      const ttlMs = envInt('PENDING_REF_TTL_HOURS', 24) * 3_600_000;
      const transaction = await this.transactions.findById(transactionId, this.em.fork());
      const ageMs = transaction ? Date.now() - transaction.createdAt.getTime() : 0;

      if (attempts >= maxAttempts || ageMs > ttlMs) {
        log.warn({ transactionId, attempts, ageMs }, 'pending reference exhausted; rejecting');
        await this.useCase.rejectPendingReference(transactionId, `pending-ref:${transactionId}`);
      } else {
        const nextRetryAt = new Date(Date.now() + backoffMs(attempts));
        await this.transactions.schedulePendingReferenceRetry(transactionId, nextRetryAt, this.em.fork());
      }
    } catch (err) {
      // erro transitório (banco indisponível, lock etc.): o próximo ciclo pega
      log.warn({ transactionId, err: err instanceof Error ? err.message : err }, 'pending reference retry failed; will retry');
    }
  }
}
