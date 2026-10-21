import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  processedAt: string;
}

type Props = IntegrationEventProps<WagerTransactionProcessedData>;

/** Emitido para qualquer transação aplicada, inclusive LOSS (§11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: Props) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: ctx.aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        processedAt: (transaction.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}
