import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { createLogger } from '../../../shared/infrastructure/logging/logger';
import { CLOCK, type ClockPort } from '../../../shared/application/ports/clock-port';
import { ENTITY_MANAGER } from '../../../shared/infrastructure/database/database.module';
import { EVENT_PUBLISHER, type EventPublisherPort } from '../ports/event-publisher';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '../ports/outbox-repository';
import { metrics } from '../../../shared/infrastructure/metrics/metrics';

const log = createLogger('outbox-publisher');

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Publica os eventos pendentes da outbox (§11, ADR-005).
 *
 * Executa em TODAS as instâncias: a reivindicação usa FOR UPDATE SKIP
 * LOCKED — concorrentes não pegam as mesmas mensagens nem se bloqueiam.
 * O ciclo é: claim + publish + markPublished na MESMA transação; crash
 * antes do publish → mensagem continua PENDING (outra instância assume);
 * crash depois do publish e antes do commit → republicação, que é segura
 * porque o consumidor deduplica por eventId.
 *
 * Falha → rollback + scheduleRetry (backoff 2^n, teto 60s) em transação
 * própria; após OUTBOX_MAX_ATTEMPTS a mensagem vai a DEAD (nunca apagada).
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') {
      log.info('publisher disabled (WORKERS_ENABLED=false)');
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, envInt('OUTBOX_POLL_INTERVAL_MS', 1000));
    log.info('publisher started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.updateOutboxGauges();
      const published = await this.publishBatch(envInt('OUTBOX_BATCH_SIZE', 50));
      if (published > 0) log.debug({ published }, 'outbox batch published');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'outbox publish failed');
    }
  }

  /** Gauges de atraso: idade da mensagem PENDING mais antiga e backlog. */
  private async updateOutboxGauges(): Promise<void> {
    try {
      const rows = (await this.em.fork().getConnection().execute(
        `SELECT COUNT(*) AS n, COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0) AS lag
         FROM outbox_messages WHERE status = 'PENDING'`,
      )) as { n: string; lag: string }[];
      metrics.setOutboxLag(Number(rows[0]?.lag ?? 0));
      metrics.setOutboxPending(Number(rows[0]?.n ?? 0));
    } catch {
      // gauges são best-effort: falha de leitura não pode parar a publicação
    }
  }

  /** Publica até `limit` mensagens; retorna quantas foram publicadas. */
  async publishBatch(limit: number): Promise<number> {
    let published = 0;
    for (let i = 0; i < limit; i++) {
      const ok = await this.publishOne();
      if (!ok) break;
      published += 1;
    }
    return published;
  }

  private async publishOne(): Promise<boolean> {
    let claimedId: string | undefined;
    try {
      return await this.em.fork().transactional(async (tx) => {
        const messages = await this.outbox.claimPending(1, tx);
        const message = messages[0];
        if (!message) return false;
        claimedId = message.id;
        await this.publisher.publish(message);
        message.markPublished(this.clock.now());
        await this.outbox.update(message, tx);
        return true;
      });
    } catch (err) {
      if (claimedId) {
        await this.scheduleRetry([claimedId]).catch((scheduleErr) => {
          log.error({ err: scheduleErr instanceof Error ? scheduleErr.message : scheduleErr }, 'failed to schedule retry');
        });
      }
      if (err instanceof Error && err.message.includes('not configured')) {
        log.warn('events queue not configured; publisher idle');
        return false;
      }
      throw err;
    }
  }

  private async scheduleRetry(ids: string[]): Promise<void> {
    const maxAttempts = envInt('OUTBOX_MAX_ATTEMPTS', 20);
    await this.em.fork().transactional(async (tx) => {
      for (const id of ids) {
        const message = await this.outbox.lockById(id, tx);
        if (!message || !message.isPending()) continue;
        metrics.incRetry('outbox_publish');
        message.scheduleRetry(this.clock.now());
        if (message.attempts >= maxAttempts) {
          message.markDead();
          metrics.incOutboxDead();
          log.error({ messageId: message.id, attempts: message.attempts }, 'outbox message moved to DEAD');
        }
        await this.outbox.update(message, tx);
      }
    });
  }
}
