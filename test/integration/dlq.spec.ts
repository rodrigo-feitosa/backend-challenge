import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createWallet, playerIdFrom, startTestApp, type TestApp } from '../support/test-app';
import { startTestSqs, type TestSqs } from '../support/test-sqs';

/**
 * I5 (seção 13): retry e DLQ — mensagem com erro permanente vai à DLQ
 * com payload auditável, e a fila principal fica limpa.
 */
describe('DLQ (I5)', () => {
  let app: TestApp;
  let sqs: TestSqs;
  let base: string;

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 300): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met within timeout');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  beforeAll(async () => {
    sqs = await startTestSqs();
    app = await startTestApp({
      CONSUMER_ENABLED: 'true',
      SQS_ENDPOINT: sqs.endpoint,
      SQS_QUEUE_TRANSACTIONS_URL: sqs.queueUrls.transactions,
      SQS_QUEUE_DLQ_URL: sqs.queueUrls.dlq,
      SQS_QUEUE_EVENTS_URL: sqs.queueUrls.events,
      VISIBILITY_TIMEOUT_S: '5',
      CONSUMER_WAIT_TIME_S: '1',
      DLQ_MAX_RECEIVES: '3',
    });
    base = app.baseUrl;
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    await sqs?.stop();
  }, 30_000);

  it('erro permanente (payload inutilizável) → DLQ + ack imediato', async () => {
    const player = playerIdFrom('15a00000001');
    await createWallet(base, player, '100.00');

    await sqs.sendTransaction({
      messageId: 'msg-i5-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'i5-ext-1',
        idempotencyKey: 'provider-a:i5-ext-1',
        playerId: player,
        walletId: '00000000-0000-0000-0000-000000000000',
        roundId: 'round-i5',
        gameId: 'fortune-chimp',
        kind: 'OPENING', // permanente: nunca submissível (§6.3)
        money: { amount: '10.00', currency: 'BRL' },
      },
    });

    const body = await (async () => {
      const startedAt = Date.now();
      for (;;) {
        const dlq = await sqs.receiveFromDlq();
        if (dlq) return dlq;
        if (Date.now() - startedAt > 15_000) throw new Error('DLQ message not received in time');
        await new Promise((r) => setTimeout(r, 300));
      }
    })();

    expect(body).toContain('"originalMessageId"');
    const parsed = JSON.parse(body) as { error: { message: string }; originalBody: string };
    expect(parsed.error.message).toContain('OPENING');
    expect(parsed.originalBody).toContain('i5-ext-1');

    await waitFor(async () => (await sqs.queueCount(sqs.queueUrls.transactions)) === 0);
  }, 30_000);

  it('envelope malformado (JSON inválido) → DLQ + ack', async () => {
    await sqs.client.send(new SendMessageCommand({
      QueueUrl: sqs.queueUrls.transactions,
      MessageBody: '{not json',
      MessageGroupId: 'g',
      MessageDeduplicationId: 'dedup-invalid-json',
    }));

    const body = await (async () => {
      const startedAt = Date.now();
      for (;;) {
        const dlq = await sqs.receiveFromDlq();
        if (dlq) return dlq;
        if (Date.now() - startedAt > 15_000) throw new Error('DLQ message not received in time');
        await new Promise((r) => setTimeout(r, 300));
      }
    })();

    expect(body).toContain('not valid JSON');
  }, 30_000);
});
