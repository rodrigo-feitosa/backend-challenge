import { WalletLedgerEntrySchema, WalletSchema } from '../../../wallets/infrastructure/wallet.entities';
import { WagerTransactionSchema } from '../../../wagering/infrastructure/wager-transaction.entity';
import { InboxMessageSchema, OutboxMessageSchema } from '../../../messaging/infrastructure/inbox-outbox.entities';

/**
 * Registro central de entidades MikroORM.
 * O domínio permanece livre de decorators; as entidades de infraestrutura
 * de cada módulo são mapeadas e registradas aqui.
 */
export const entities = [
  WalletSchema,
  WalletLedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
