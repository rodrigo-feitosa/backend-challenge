import { Counter, Gauge, Histogram, collectDefaultMetrics, Registry } from 'prom-client';

/**
 * Métricas Prometheus (seção 12 do desafio).
 *
 * Singleton por processo — como o logger, vive fora do DI para permitir
 * instrumentação pontual sem engessar os construtores dos use cases.
 * Valores de dinheiro NUNCA viram labels/métricas (cardinalidade e [S12]).
 */
export class WageringMetrics {
  readonly registry = new Registry();

  /** Transações por resultado, provedor e tipo. */
  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by terminal outcome, provider and kind',
    labelNames: ['status', 'provider', 'kind'] as const,
    registers: [this.registry],
  });

  /** Duplicatas detectadas (replay de idempotência HTTP, inbox SQS). */
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicate submissions detected (idempotent replays), by channel',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  /** Tentativas/retries por estágio (consumer_redelivery, outbox_publish, pending_reference). */
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retry attempts by stage',
    labelNames: ['stage'] as const,
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages moved to the dead-letter queue',
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Concurrent modification conflicts detected (CAS mismatch under lock)',
    registers: [this.registry],
  });

  private readonly lockWait = new Histogram({
    name: 'lock_wait_seconds',
    help: 'Time spent acquiring the pessimistic wallet lock',
    registers: [this.registry],
  });

  /** now − occurred_at da mensagem PENDING mais antiga da outbox. */
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest PENDING outbox message (0 when none)',
    registers: [this.registry],
  });

  /** Mensagens pendentes na outbox (sinal de atraso de publicação). */
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Number of PENDING messages in the outbox',
    registers: [this.registry],
  });

  private readonly outboxDead = new Counter({
    name: 'outbox_dead_total',
    help: 'Outbox messages moved to DEAD after exhausting retries',
    registers: [this.registry],
  });

  private readonly processingLatency = new Histogram({
    name: 'processing_latency_seconds',
    help: 'End-to-end latency of wager transaction submissions, by channel',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Wallet reconciliations that detected stored balance != ledger sum',
    registers: [this.registry],
  });

  constructor() {
    // métricas de processo (GC, heap, event loop) como complemento
    collectDefaultMetrics({ register: this.registry });
  }

  incTransaction(status: string, provider: string, kind: string): void {
    this.transactions.inc({ status, provider, kind });
  }

  incDuplicate(channel: string): void {
    this.duplicates.inc({ channel });
  }

  incRetry(stage: string): void {
    this.retries.inc({ stage });
  }

  incDlq(): void {
    this.dlqMessages.inc();
  }

  incLockConflict(): void {
    this.lockConflicts.inc();
  }

  /** Segundos de espera pelo lock pessimista da wallet. */
  observeLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }

  observeProcessingLatency(channel: string, seconds: number): void {
    this.processingLatency.observe({ channel }, seconds);
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(Math.max(0, seconds));
  }

  setOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }

  incOutboxDead(): void {
    this.outboxDead.inc();
  }

  incReconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}

export const metrics = new WageringMetrics();
