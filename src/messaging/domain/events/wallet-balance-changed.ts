import type { MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from '../../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../../wallets/domain/wallet-ledger-entry';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

type Props = IntegrationEventProps<WalletBalanceChangedData>;

/** Emitido SOMENTE quando o saldo muda (§11). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: Props) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
