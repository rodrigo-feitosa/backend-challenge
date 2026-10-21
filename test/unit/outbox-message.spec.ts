import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/wagering/domain/wager-transaction';
import { IntegrationEvent, type EventContext } from '../../src/messaging/domain/integration-event';
import { WagerTransactionProcessed } from '../../src/messaging/domain/events/wager-transaction-processed';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';

const AT = new Date('2026-01-15T12:00:00.000Z');

function sampleTransaction(): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: AT,
  });
}

describe('IntegrationEvent — envelope', () => {
  it('toJSON serializa com eventType/version do tipo e occurredAt ISO-8601', () => {
    const ctx: EventContext = {
      eventId: 'evt-1',
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      causationId: 'tx-1',
      occurredAt: AT,
    };
    const event = WagerTransactionProcessed.from(sampleTransaction(), ctx);
    const json = event.toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.eventId).toBe('evt-1');
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('tx-1');
    expect(json.occurredAt).toBe(AT.toISOString());
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' }); // MoneyProps, nunca Money
    expect(typeof json.data.money.amount).toBe('string');
  });
});

describe('OutboxMessage', () => {
  it('enqueue nasce PENDING, attempts 0, due imediatamente', () => {
    const ctx: EventContext = { eventId: 'evt-1', aggregateId: 'w-1', correlationId: 'c', occurredAt: AT };
    const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(sampleTransaction(), ctx));
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isDue(AT)).toBe(true);
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect((message.payload as { eventType: string }).eventType).toBe('WagerTransactionProcessed');
  });

  it('markPublished define publishedAt e encerra pending', () => {
    const ctx: EventContext = { eventId: 'e', aggregateId: 'a', correlationId: 'c', occurredAt: AT };
    const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(sampleTransaction(), ctx));
    message.markPublished(new Date('2026-01-15T12:01:00.000Z'));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(AT)).toBe(false);
    expect(message.publishedAt).toEqual(new Date('2026-01-15T12:01:00.000Z'));
  });

  it('scheduleRetry aplica backoff exponencial com teto de 60s', () => {
    const ctx: EventContext = { eventId: 'e', aggregateId: 'a', correlationId: 'c', occurredAt: AT };
    const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(sampleTransaction(), ctx));
    const now = new Date('2026-01-15T12:00:00.000Z');

    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 2000)); // 2^1 * 1s

    message.scheduleRetry(now);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 4000));

    // muitas tentativas: teto de 60s
    for (let i = 0; i < 10; i++) message.scheduleRetry(now);
    expect(message.attempts).toBe(12);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 60000));
    expect(message.isDue(now)).toBe(false); // ainda não venceu
  });

  it('isDue respeita nextAttemptAt', () => {
    const ctx: EventContext = { eventId: 'e', aggregateId: 'a', correlationId: 'c', occurredAt: AT };
    const message = OutboxMessage.enqueue(WagerTransactionProcessed.from(sampleTransaction(), ctx));
    message.scheduleRetry(AT);
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(new Date(AT.getTime() + 2001))).toBe(true);
  });
});

// guard: o envelope é abstrato — não pode ser instanciado diretamente
abstract class EnvelopeShape extends IntegrationEvent<{ a: number }> {}
void EnvelopeShape;
