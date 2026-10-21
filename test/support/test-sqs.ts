import { CreateQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { startContainer, stopContainer } from './docker-harness';

/**
 * LocalStack real para testes de mensageria (nunca mock de SQS).
 * Sobe o container, cria as filas FIFO do desafio e expõe helpers.
 */
export interface TestSqs {
  client: SQSClient;
  endpoint: string;
  queueUrls: { transactions: string; dlq: string; events: string };
  sendTransaction(envelope: Record<string, unknown>): Promise<void>;
  receiveFromDlq(): Promise<string | null>;
  queueCount(queueUrl: string): Promise<number>;
  stop(): Promise<void>;
}

let seq = 0;

export async function startTestSqs(): Promise<TestSqs> {
  seq += 1;
  const name = `wagering-test-sqs-${process.pid}-${seq}`;
  const container = await startContainer({
    image: 'localstack/localstack:3.8.1',
    name,
    env: ['SERVICES=sqs', 'DEBUG=0'],
    internalPort: 4566,
  });
  const endpoint = `http://127.0.0.1:${container.hostPort}`;
  const client = new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  // espera o SQS responder
  const startedAt = Date.now();
  for (;;) {
    try {
      await client.send(new GetQueueAttributesCommand({ QueueUrl: `${endpoint}/000000000000/x`, AttributeNames: ['QueueArn'] }));
    } catch (err) {
      if ((err as { name?: string }).name === 'QueueDoesNotExist') break; // SQS respondeu
      if (Date.now() - startedAt > 30_000) throw new Error('LocalStack SQS did not become ready', { cause: err });
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    break;
  }

  const base = `${endpoint}/000000000000`;
  const dlqUrl = `${base}/wager-transactions-dlq.fifo`;
  const transactionsUrl = `${base}/wager-transactions.fifo`;
  const eventsUrl = `${base}/wagering-events.fifo`;

  await client.send(new CreateQueueCommand({
    QueueName: 'wager-transactions-dlq.fifo',
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
  }));
  await client.send(new CreateQueueCommand({
    QueueName: 'wager-transactions.fifo',
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true', VisibilityTimeout: '90' },
  }));
  await client.send(new CreateQueueCommand({
    QueueName: 'wagering-events.fifo',
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' },
  }));

  return {
    client,
    endpoint,
    queueUrls: { transactions: transactionsUrl, dlq: dlqUrl, events: eventsUrl },
    async sendTransaction(envelope: Record<string, unknown>): Promise<void> {
      await client.send(new SendMessageCommand({
        QueueUrl: transactionsUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: String(envelope.data && typeof envelope.data === 'object' ? (envelope.data as { walletId?: string }).walletId ?? 'group' : 'group'),
        MessageDeduplicationId: `dedup-${Math.random().toString(36).slice(2)}`,
      }));
    },
    async receiveFromDlq(): Promise<string | null> {
      const res = await client.send(new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }));
      const message = res.Messages?.[0];
      if (!message?.Body || !message.ReceiptHandle) return null;
      // FIFO re-entrega a mesma mensagem sem ack — deletamos para ver a próxima
      await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }));
      return message.Body;
    },
    async queueCount(queueUrl: string): Promise<number> {
      const res = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      const visible = Number.parseInt(res.Attributes?.ApproximateNumberOfMessages ?? '0', 10);
      const inflight = Number.parseInt(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
      return visible + inflight;
    },
    stop: async () => {
      await stopContainer(name);
    },
  };
}
