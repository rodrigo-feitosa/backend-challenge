import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { startTestDatabase, type TestDatabase } from '../support/test-db';
import { startAppProcess, waitFor, type AppProcessHandle } from '../support/process-harness';
import { startTestSqs, type TestSqs } from '../support/test-sqs';
import { assertWalletLedgerInvariant } from '../support/invariants';

/**
 * C5 (seção 13): worker morto com SIGKILL após commit e antes do ack.
 * A redelivery (visibility timeout) NÃO duplica efeitos: inbox + snapshot.
 * E cenário §11: crash pós-commit pré-publicação → outra instância publica.
 */
describe('C5 — crash pós-commit, pré-ack', () => {
  let db: TestDatabase;
  let sqs: TestSqs;
  let victim: AppProcessHandle;
  let survivor: AppProcessHandle;
  let dbUrl: string;

  const client = (): SQSClient =>
    new SQSClient({
      endpoint: sqs.endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

  beforeAll(async () => {
    db = await startTestDatabase();
    dbUrl = `postgresql://test:test@127.0.0.1:${db.hostPort}/wagering_test`;
    sqs = await startTestSqs();
    const consumerEnv = (port: string): Record<string, string> => ({
      DATABASE_URL: dbUrl,
      LOG_LEVEL: 'warn',
      CONSUMER_ENABLED: 'true',
      WORKERS_ENABLED: 'false',
      SQS_ENDPOINT: sqs.endpoint,
      SQS_QUEUE_TRANSACTIONS_URL: sqs.queueUrls.transactions,
      SQS_QUEUE_DLQ_URL: sqs.queueUrls.dlq,
      SQS_QUEUE_EVENTS_URL: sqs.queueUrls.events,
      VISIBILITY_TIMEOUT_S: '2',
      CONSUMER_WAIT_TIME_S: '1',
      DLQ_MAX_RECEIVES: '5',
      PORT: port,
    });
    victim = await startAppProcess(consumerEnv('0')); // porta atribuída pelo harness
    survivor = await startAppProcess(consumerEnv('0'));
  }, 150_000);

  afterAll(async () => {
    await victim?.kill('SIGKILL').catch(() => undefined);
    await survivor?.kill('SIGTERM').catch(() => undefined);
    await sqs?.stop();
    await db?.stop();
  }, 30_000);

  it('lote em processamento, SIGKILL após commit → redelivery não duplica débitos', async () => {
    const player = '01940000-0000-7000-8000-000000000001';
    const createRes = await fetch(`${survivor.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: player, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(createRes.status).toBe(201);
    const walletId = ((await createRes.json()) as { id: string }).id;

    const sqsClient = client();
    const MESSAGES = 10;
    for (let i = 0; i < MESSAGES; i++) {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: sqs.queueUrls.transactions,
          MessageGroupId: walletId,
          MessageDeduplicationId: `c5-${i}`,
          MessageBody: JSON.stringify({
            messageId: `c5-msg-${i}`,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              providerId: 'provider-a',
              externalTransactionId: `c5-tx-${i}`,
              idempotencyKey: `provider-a:c5-tx-${i}`,
              playerId: player,
              walletId,
              roundId: 'round-c5',
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
          }),
        }),
      );
    }

    // espera os commits aparecerem no banco e mata a vítima imediatamente —
    // com o lote em voo, algumas mensagens estão commitadas mas ainda sem ack
    await waitFor(
      async () => {
        const res = await fetch(`${survivor.baseUrl}/wallets/${walletId}`);
        const body = (await res.json()) as { balance: { amount: string } };
        return body.balance.amount !== '100.00';
      },
      { timeoutMs: 15000, intervalMs: 50 },
    );
    await victim.kill('SIGKILL');

    // a sobrevivente drena tudo: redeliveries viram DUPLICATE (inbox) ou
    // processam as que a vítima não chegou a commitar — sem duplicar débitos
    await waitFor(async () => (await sqs.queueCount(sqs.queueUrls.transactions)) === 0, { timeoutMs: 60000, intervalMs: 500 });

    const finalRes = await fetch(`${survivor.baseUrl}/wallets/${walletId}`);
    const finalWallet = (await finalRes.json()) as { balance: { amount: string } };
    // exatamente 10 débitos de 1.00 — nenhum duplicado
    expect(finalWallet.balance.amount).toBe('90.00');

    const invariant = await assertWalletLedgerInvariant(survivor.baseUrl, walletId, 'C5');
    expect(invariant.entries).toBe(MESSAGES + 1); // OPENING + 10 debits
  }, 120_000);

  it('cenário §11: crash pós-commit pré-publicação → outra instância publica os eventos', async () => {
    const sqsClient = client();
    // instancia com consumer (commita transações) mas SEM publisher:
    // simula morte antes da publicação — os eventos ficam PENDING na outbox
    const player = '01940000-0000-7000-8000-000000000002';
    const createRes = await fetch(`${survivor.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: player, initialBalance: { amount: '50.00', currency: 'BRL' } }),
    });
    const walletId = ((await createRes.json()) as { id: string }).id;

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: sqs.queueUrls.transactions,
        MessageGroupId: walletId,
        MessageDeduplicationId: 'c5b-1',
        MessageBody: JSON.stringify({
          messageId: 'c5b-msg-1',
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId: 'c5b-tx-1',
            idempotencyKey: 'provider-a:c5b-tx-1',
            playerId: player,
            walletId,
            roundId: 'round-c5b',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '5.00', currency: 'BRL' },
          },
        }),
      }),
    );

    // aguarda o commit (transação + evento PENDING na outbox)
    await waitFor(
      async () => {
        const rows = (await db.orm.em.fork().execute(`SELECT COUNT(*) AS n FROM outbox_messages WHERE status = 'PENDING'`)) as { n: string }[];
        return Number(rows[0].n) >= 2; // Processed + WalletBalanceChanged
      },
      { timeoutMs: 15000 },
    );

    // "outra instância assume": publisher em processo dedicado drena a outbox
    const publisher = await startAppProcess({
      DATABASE_URL: dbUrl,
      LOG_LEVEL: 'warn',
      CONSUMER_ENABLED: 'false',
      WORKERS_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '200',
      SQS_ENDPOINT: sqs.endpoint,
      SQS_QUEUE_TRANSACTIONS_URL: sqs.queueUrls.transactions,
      SQS_QUEUE_DLQ_URL: sqs.queueUrls.dlq,
      SQS_QUEUE_EVENTS_URL: sqs.queueUrls.events,
    });
    try {
      await waitFor(
        async () => {
          const rows = (await db.orm.em.fork().execute(`SELECT COUNT(*) AS n FROM outbox_messages WHERE status = 'PENDING'`)) as { n: string }[];
          return Number(rows[0].n) === 0;
        },
        { timeoutMs: 30000 },
      );

      // os eventos chegam na fila de eventos (dedup por eventId garante 1x).
      // A fila pode conter eventos de outros testes — contamos apenas os
      // desta wallet (aggregateId = walletId)
      let received = 0;
      for (;;) {
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: sqs.queueUrls.events,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        const messages = res.Messages ?? [];
        if (messages.length === 0) break;
        for (const m of messages) {
          const body = JSON.parse(m.Body ?? '{}') as { aggregateId?: string };
          if (body.aggregateId === walletId) received += 1;
          if (m.ReceiptHandle) {
            await sqsClient.send(new DeleteMessageCommand({ QueueUrl: sqs.queueUrls.events, ReceiptHandle: m.ReceiptHandle }));
          }
        }
        if (received > 50) break;
      }
      expect(received).toBe(2); // Processed + WalletBalanceChanged
    } finally {
      await publisher.kill('SIGTERM');
    }
  }, 120_000);
});
