import { Module } from '@nestjs/common';
import { MikroLedgerRepository } from './infrastructure/mikro-ledger.repository';
import { MikroWalletRepository } from './infrastructure/mikro-wallet.repository';
import { LEDGER_REPOSITORY } from './application/ports/ledger-repository';
import { WALLET_REPOSITORY } from './application/ports/wallet-repository';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { WalletQueries } from './application/wallet-queries';
import { WalletsController } from './presentation/wallets.controller';
import { WAGER_TRANSACTION_REPOSITORY } from '../wagering/application/ports/wager-transaction-repository';
import { MikroWagerTransactionRepository } from '../wagering/infrastructure/mikro-wager-transaction.repository';

/**
 * Módulo de wallets: use cases, repositórios (portas → MikroORM) e API HTTP.
 */
@Module({
  controllers: [WalletsController],
  providers: [
    OpenWalletUseCase,
    WalletQueries,
    { provide: WALLET_REPOSITORY, useClass: MikroWalletRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroLedgerRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroWagerTransactionRepository },
  ],
})
export class WalletsModule {}
