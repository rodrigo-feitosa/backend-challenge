import type { IntegrationEvent } from './integration-event';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'DEAD';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  version: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Mensagem da transactional outbox (§6.5/§11). Gravada na MESMA transação
 * da alteração financeira; um worker posterior publica e marca PUBLISHED.
 * Retry: attempts+1 e nextAttemptAt = now + min(2^attempts × 1s, 60s) (ADR-005);
 * após o limite de tentativas o worker a move para DEAD (nunca apagada).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly version: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _status: OutboxStatus,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
  ) {}

  /** Nasce PENDING, attempts = 0, due imediatamente. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const json = event.toJSON();
    return new OutboxMessage(
      json.eventId,
      json.aggregateId,
      json.eventType,
      json.version,
      json as unknown as Record<string, unknown>,
      event.occurredAt,
      'PENDING',
      0,
      undefined,
      undefined,
      json.correlationId,
      json.causationId,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.version,
      state.payload,
      state.occurredAt,
      state.status,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.correlationId,
      state.causationId,
    );
  }

  get status(): OutboxStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._status === 'PENDING';
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (this._status !== 'PENDING') {
      throw new Error(`cannot publish outbox message ${this.id} in status ${this._status}`);
    }
    this._status = 'PUBLISHED';
    this._publishedAt = at;
  }

  /** Chamado pelo worker quando a publicação falha. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delayMs = Math.min(2 ** this._attempts * 1000, 60_000);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  markDead(): void {
    this._status = 'DEAD';
  }
}
