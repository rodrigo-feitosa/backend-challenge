import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string;
  attempts: number;
  nextRetryAt: string;
}

type Props = IntegrationEventProps<WagerTransactionPendingReferenceData>;

/** Emitido quando a referência está ausente (§11, regra 7.8). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: Props) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    schedule: { attempts: number; nextRetryAt: Date },
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
        attempts: schedule.attempts,
        nextRetryAt: schedule.nextRetryAt.toISOString(),
      },
    });
  }
}
