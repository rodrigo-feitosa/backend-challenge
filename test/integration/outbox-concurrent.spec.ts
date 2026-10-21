import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { MikroOutboxRepository } from '../../src/messaging/infrastructure/mikro-outbox.repository';
import type { EventPublisherPort } from '../../src/messaging/application/ports/event-publisher';
import { OutboxPublisherWorker } from '../../src/messaging/application/workers/outbox-publisher.worker';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/messaging/domain/events/wager-transaction-processed';
import { WagerTransaction, WagerTransactionKind } from '../../src/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';
import { SystemClock } from '../../src/shared/infrastructure/id-clock.providers';
import { startTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * I4/C6 (seções 11 e 13): dois publishers REAIS sobre a mesma outbox.
 * SKIP LOCKED garante que nenhuma mensagem é perdida e nenhuma fica
 * presa; publicação duplicada (crash entre publish e mark) é permitida
 * pelo desenho e coberta pelo consumidor via eventId.
 */
describe('publishers concorrentes na outbox (I4/C6)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let seq = 0;

  const TOTAL = 30;

  /** Publisher falso NA BORDA DA PORTA (permitido): registra cada publicação. */
  class RecordingPublisher implements EventPublisherPort {
    readonly publishedIds: string[] = [];
    async publish(message: { id: string }): Promise<void> {
      this.publishedIds.push(message.id);
      // pequena latência para forçar sobreposição entre workers
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function enqueueEvent(): Promise<string> {
    seq += 1;
    const transaction = WagerTransaction.rehydrate({
      id: `01920000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
      providerId: 'provider-a',
      externalTransactionId: 'ext',
      idempotencyKey: 'key',
      payloadHash: 'a'.repeat(64),
      walletId: '01920000-0000-7000-8000-000000000001',
      playerId: 'p',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      createdAt: new Date(),
      status: 'PROCESSED',
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: new Date(),
    });
    const event = WagerTransactionProcessed.from(transaction, {
      eventId: `01920000-0000-7000-8000-${String(100000 + seq).padStart(12, '0')}`,
      aggregateId: transaction.walletId,
      correlationId: 'test',
      causationId: transaction.id,
      occurredAt: new Date(),
    });
    const message = OutboxMessage.enqueue(event);
    await new MikroOutboxRepository().enqueue(message, orm.em.fork());
    return message.id;
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    orm = db.orm;
  }, 90_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('30 mensagens, 2 workers simultâneos: todas publicadas exatamente uma vez, nenhuma perdida ou presa', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < TOTAL; i++) {
      ids.add(await enqueueEvent());
    }

    const publisherA = new RecordingPublisher();
    const publisherB = new RecordingPublisher();
    const workerA = new OutboxPublisherWorker(
      new MikroOutboxRepository(),
      publisherA,
      new SystemClock(),
      orm.em.fork(),
    );
    const workerB = new OutboxPublisherWorker(
      new MikroOutboxRepository(),
      publisherB,
      new SystemClock(),
      orm.em.fork(),
    );

    // dois workers drenando a mesma outbox ao mesmo tempo
    await Promise.all([workerA.publishBatch(TOTAL), workerB.publishBatch(TOTAL)]);

    // drenagem final: pode restar apenas o que eventualmente ficou para o outro worker
    const closer = new OutboxPublisherWorker(new MikroOutboxRepository(), publisherA, new SystemClock(), orm.em.fork());
    await closer.publishBatch(TOTAL);

    const em = orm.em.fork();
    const rows = (await em.execute(
      `SELECT status, COUNT(*) AS n FROM outbox_messages WHERE id = ANY($1::uuid[]) GROUP BY status`,
      [[...ids]],
    )) as { status: string; n: string }[];
    const byStatus = new Map(rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus.get('PUBLISHED')).toBe(TOTAL);
    expect(byStatus.get('PENDING')).toBeUndefined();

    // nenhuma mensagem publicada por ambos os workers (SKIP LOCKED: cada uma 1 vez)
    const allPublished = [...publisherA.publishedIds, ...publisherB.publishedIds];
    expect(allPublished.length).toBe(TOTAL);
    expect(new Set(allPublished).size).toBe(TOTAL);
    for (const id of ids) expect(allPublished).toContain(id);
  });
});
