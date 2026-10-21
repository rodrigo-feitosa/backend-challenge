import { Global, Module } from '@nestjs/common';
import { MikroLedgerRepository } from '../../wallets/infrastructure/mikro-ledger.repository';
import { MikroWalletRepository } from '../../wallets/infrastructure/mikro-wallet.repository';
import { MikroWagerTransactionRepository } from '../../wagering/infrastructure/mikro-wager-transaction.repository';
import { LEDGER_REPOSITORY } from '../../wallets/application/ports/ledger-repository';
import { WALLET_REPOSITORY } from '../../wallets/application/ports/wallet-repository';
import { WAGER_TRANSACTION_REPOSITORY } from '../../wagering/application/ports/wager-transaction-repository';

/**
 * Módulo global de repositórios (implementações MikroORM das portas).
 * Global para evitar dependência circular entre os módulos de domínio
 * (o use case de wagering usa o repositório de wallets e vice-versa).
 */
@Global()
@Module({
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroWalletRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroLedgerRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroWagerTransactionRepository },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY],
})
export class RepositoriesModule {}
