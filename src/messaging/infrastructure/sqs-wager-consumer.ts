import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { SQS_CLIENT, getSqsQueueUrls } from './sqs/sqs.module';
import { ConsumeWagerTransactionHandler, classifyConsumerError } from '../application/consume-wager-transaction.handler';
import { createLogger } from '../../shared/infrastructure/logging/logger';

const log = createLogger('sqs-consumer');

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Consumer de `wager-transactions.fifo` (§10 do desafio):
 * - long polling; processa o lote em paralelo (a garantia de correção é o banco);
 * - chama o MESMO use case do canal HTTP (inbox cuida da deduplicação);
 * - ack (delete) SOMENTE após o commit;
 * - erros: negócio → resultado + ack; transitório → sem ack (redelivery
 *   pelo visibility timeout) até DLQ_MAX_RECEIVES; permanente → DLQ + ack;
 * - SIGTERM: para o polling e aguarda in-flight até 30s (conclui e acka)
 *   ou deixa a mensagem voltar.
 */
@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly handler: ConsumeWagerTransactionHandler,
  ) {}

  onModuleInit(): void {
    if (process.env.CONSUMER_ENABLED === 'false') {
      log.info('consumer disabled (CONSUMER_ENABLED=false)');
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
    log.info('consumer started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.inFlight.size === 0) {
      log.info('consumer stopped (no in-flight messages)');
      return;
    }
    log.info({ inFlight: this.inFlight.size }, 'SIGTERM: waiting for in-flight messages (up to 30s)...');
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
    await Promise.race([Promise.allSettled([...this.inFlight]), timeout]);
    log.info('consumer stopped');
  }

  private async pollLoop(): Promise<void> {
    const queueUrl = getSqsQueueUrls().transactions;
    while (this.running) {
      if (!queueUrl) {
        log.error('SQS_QUEUE_TRANSACTIONS_URL not configured; consumer idle');
        await sleep(5000);
        continue;
      }
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: Math.min(envInt('CONSUMER_WAIT_TIME_S', 20), 20),
            VisibilityTimeout: envInt('VISIBILITY_TIMEOUT_S', 90),
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        const messages = response.Messages ?? [];
        if (messages.length > 0) {
          await Promise.allSettled(messages.map((m) => this.track(this.handle(m, queueUrl))));
        }
      } catch (err) {
        if (!this.running) break;
        log.error({ err: err instanceof Error ? err.message : err }, 'receive failed; retrying');
        await sleep(envInt('CONSUMER_RETRY_DELAY_MS', 1000));
      }
    }
  }

  private track(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  private async handle(message: Message, queueUrl: string): Promise<void> {
    const messageId = message.MessageId ?? 'unknown';
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    const startedAt = Date.now();
    try {
      await this.handler.process(message);
      await this.ack(message, queueUrl); // ack somente após o commit
      log.debug({ messageId, receiveCount, durationMs: Date.now() - startedAt }, 'message processed and acknowledged');
    } catch (err) {
      const classification = classifyConsumerError(err);
      if (classification === 'transient' && receiveCount < envInt('DLQ_MAX_RECEIVES', 3)) {
        log.warn({ messageId, receiveCount, err: err instanceof Error ? err.message : err }, 'transient failure; message returns to queue (no ack)');
        return; // sem ack → visibility timeout devolve a mensagem
      }
      log.error(
        { messageId, receiveCount, classification, err: err instanceof Error ? err.message : err },
        classification === 'transient' ? 'transient failure after max receives; sending to DLQ' : 'permanent failure; sending to DLQ',
      );
      await this.toDlq(message, messageId, receiveCount, err);
      await this.ack(message, queueUrl);
    }
  }

  private async ack(message: Message, queueUrl: string): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async toDlq(message: Message, messageId: string, receiveCount: number, err: unknown): Promise<void> {
    const dlqUrl = getSqsQueueUrls().dlq;
    if (!dlqUrl) {
      log.error({ messageId }, 'DLQ not configured; message will redrive via queue policy');
      return;
    }
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: JSON.stringify({
          originalMessageId: messageId,
          originalBody: message.Body,
          receiveCount,
          failedAt: new Date().toISOString(),
          error: {
            name: err instanceof Error ? err.name : 'Unknown',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
        MessageGroupId: 'dlq',
        MessageDeduplicationId: messageId,
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
