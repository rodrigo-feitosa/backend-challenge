import type { MoneyProps } from '../../shared/domain/money';

/**
 * Eventos de domínio coletados pelo use case (gancho da ET7).
 * A ET10 persiste cada evento na transactional out dentro da MESMA
 * transação SQL, mapeando para as subclasses concretas de IntegrationEvent.
 * `data` carrega MoneyProps (string decimal) — nunca a instância de Money.
 */

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

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
}

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

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export type WageringDomainEvent =
  | { eventType: 'WagerTransactionProcessed'; aggregateId: string; data: WagerTransactionProcessedData }
  | { eventType: 'WagerTransactionRejected'; aggregateId: string; data: WagerTransactionRejectedData }
  | { eventType: 'WagerTransactionPendingReference'; aggregateId: string; data: WagerTransactionPendingReferenceData }
  | { eventType: 'WalletBalanceChanged'; aggregateId: string; data: WalletBalanceChangedData };

export const DOMAIN_EVENT_COLLECTOR = Symbol('DOMAIN_EVENT_COLLECTOR');

export interface DomainEventCollector {
  collect(event: WageringDomainEvent): void;
}
