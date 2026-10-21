import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWallet, playerIdFrom, startTestApp, type TestApp } from '../support/test-app';
import { startTestSqs, type TestSqs } from '../support/test-sqs';

/**
 * I3 (seção 13): inbox e redelivery — a mesma mensagem 2x → 1 efeito.
 * Consumer real, LocalStack real, PostgreSQL real.
 */
describe('inbox e redelivery (I3)', () => {
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

  const balance = async (walletId: string): Promise<string> => {
    const res = await fetch(`${base}/wallets/${walletId}`);
    return ((await res.json()) as { balance: { amount: string } }).balance.amount;
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

  it('processa mensagem da fila com o mesmo use case e faz ack após commit', async () => {
    const player = playerIdFrom('13a00000001');
    const walletId = await createWallet(base, player, '100.00');

    await sqs.sendTransaction({
      messageId: 'msg-i3-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'i3-ext-1',
        idempotencyKey: 'provider-a:i3-ext-1',
        playerId: player,
        walletId,
        roundId: 'round-i3',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    });

    await waitFor(async () => (await balance(walletId)) === '70.00');
    expect(await sqs.queueCount(sqs.queueUrls.transactions)).toBe(0);
  });

  it('a mesma mensagem 2x (mesmo messageId) → 1 efeito, segunda é ack como duplicata', async () => {
    const player = playerIdFrom('13b00000001');
    const walletId = await createWallet(base, player, '100.00');

    const envelope = {
      messageId: 'msg-i3-2',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'i3-ext-2',
        idempotencyKey: 'provider-a:i3-ext-2',
        playerId: player,
        walletId,
        roundId: 'round-i3',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    // duas cópias com messageId idêntico no envelope (dedup é do inbox, não do SQS)
    await Promise.all([sqs.sendTransaction(envelope), sqs.sendTransaction(envelope)]);

    await waitFor(async () => (await balance(walletId)) === '75.00');
    await new Promise((r) => setTimeout(r, 2000)); // dá tempo para a segunda cópia

    // apenas 1 débito: a segunda cópia foi ack (DUPLICATE) sem reprocessar
    expect(await balance(walletId)).toBe('75.00');
    await waitFor(async () => (await sqs.queueCount(sqs.queueUrls.transactions)) === 0);
  }, 30_000);

  it('rejeição de negócio na fila é ack (REJECTED é resultado, não erro)', async () => {
    const player = playerIdFrom('13c00000001');
    const walletId = await createWallet(base, player, '10.00');

    await sqs.sendTransaction({
      messageId: 'msg-i3-3',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'i3-ext-3',
        idempotencyKey: 'provider-a:i3-ext-3',
        playerId: player,
        walletId,
        roundId: 'round-i3',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      },
    });

    // REJECTED persistido; mensagem ackada; saldo não muda
    await waitFor(async () => (await sqs.queueCount(sqs.queueUrls.transactions)) === 0);
    expect(await balance(walletId)).toBe('10.00');

    const trans = await (await fetch(`${base}/providers/provider-a/wagering/transactions/i3-ext-3`)).json();
    expect(trans.status).toBe('REJECTED');
    expect(trans.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
});
