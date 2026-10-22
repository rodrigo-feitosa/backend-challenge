import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { runWithCorrelation } from '../../shared/infrastructure/logging/correlation';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction';
import { SubmitWagerTransactionUseCase, type SubmitWagerCommand } from '../../wagering/application/submit-wager-transaction.use-case';

/** Erro permanente do consumer: a mensagem nunca vai processar (DLQ). */
export class PermanentConsumerError extends DomainError {
  constructor(message: string) {
    super('PERMANENT_CONSUMER_ERROR', message);
  }
}

/** Códigos de erro PostgreSQL/driver que indicam falha TRANSITÓRIA. */
const TRANSIENT_DB_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08001', // sqlclient_unable_to establish sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '40001', // serialization_failure (retry)
  '40P01', // deadlock_detected (retry)
]);

export type ConsumerErrorClass = 'transient' | 'permanent';

/**
 * Classificação de erros do consumer (§10):
 * - negócio → resultado do use case (REJECTED etc.), nunca chega aqui;
 * - transitório (PG/infra indisponível) → sem ack, redelivery;
 * - permanente (payload inutilizável) → DLQ.
 */
export function classifyConsumerError(err: unknown): ConsumerErrorClass {
  const e = err as { code?: string; name?: string; constructor?: { name?: string } };
  if (e instanceof PermanentConsumerError) return 'permanent';
  if (typeof e?.code === 'string' && TRANSIENT_DB_CODES.has(e.code)) return 'transient';
  // MikroORM envolve erros do driver mantendo `code`; erros de conexão também
  // aparecem como DriverException/ConnectionError
  if (typeof e?.name === 'string' && /Connection|Driver/.test(e.name) && e.code === undefined) return 'transient';
  if (e instanceof DomainError && e.code === 'INFRASTRUCTURE_ERROR') return 'transient';
  // erro desconhecido (bug): DLQ para visibilidade, não retry infinito
  return 'permanent';
}

interface WagerTransactionEnvelope {
  messageId?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export const CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Adapter SQS → use case (§10): reutiliza o MESMO use case do canal HTTP,
 * com deduplicação via inbox persistente na transação do processamento.
 */
@Injectable()
export class ConsumeWagerTransactionHandler {
  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  async process(message: Message): Promise<void> {
    const body = message.Body;
    if (!body) {
      throw new PermanentConsumerError('SQS message has no body');
    }
    let envelope: WagerTransactionEnvelope;
    try {
      envelope = JSON.parse(body) as WagerTransactionEnvelope;
    } catch {
      throw new PermanentConsumerError('message body is not valid JSON');
    }
    if (envelope.type !== 'WagerTransactionRequested') {
      throw new PermanentConsumerError(`unexpected message type: ${String(envelope.type)}`);
    }
    const data = envelope.data;
    if (!data || typeof data !== 'object') {
      throw new PermanentConsumerError('message envelope has no data');
    }

    const command = this.toCommand(data);
    const messageId = (typeof envelope.messageId === 'string' && envelope.messageId !== '' ? envelope.messageId : message.MessageId) ?? 'unknown';
    // todo log do processamento desta mensagem carrega os identificadores
    return runWithCorrelation(
      { correlationId: messageId, messageId, providerId: command.providerId, walletId: command.walletId },
      () =>
        this.submit.execute(command, {
          source: 'SQS',
          correlationId: messageId,
          inbox: {
            consumerName: CONSUMER_NAME,
            messageId,
            payloadHash: createHash('sha256').update(body, 'utf8').digest('hex'),
          },
        }),
    ).then(() => undefined);
  }

  private toCommand(data: Record<string, unknown>): SubmitWagerCommand {
    const str = (field: string): string => {
      const value = data[field];
      if (typeof value !== 'string' || value === '') {
        throw new PermanentConsumerError(`field ${field} must be a non-empty string`);
      }
      return value;
    };
    const money = data.money as { amount?: unknown; currency?: unknown } | undefined;
    if (!money || typeof money.amount !== 'string' || typeof money.currency !== 'string') {
      throw new PermanentConsumerError('money must be { amount: string, currency: string }');
    }
    const reference = data.referenceExternalTransactionId;
    return {
      providerId: str('providerId'),
      externalTransactionId: str('externalTransactionId'),
      idempotencyKey: str('idempotencyKey'),
      playerId: str('playerId'),
      walletId: str('walletId'),
      roundId: str('roundId'),
      gameId: str('gameId'),
      kind: str('kind') as WagerTransactionKind,
      money: Money.from({ amount: money.amount, currency: money.currency }),
      referenceExternalTransactionId: typeof reference === 'string' ? reference : undefined,
    };
  }
}
