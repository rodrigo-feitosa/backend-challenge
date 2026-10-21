import { Module } from '@nestjs/common';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { WalletQueries } from './application/wallet-queries';
import { WalletsController } from './presentation/wallets.controller';

/**
 * Módulo de wallets: use cases e API HTTP.
 * Os repositórios vêm do RepositoriesModule (global).
 */
@Module({
  controllers: [WalletsController],
  providers: [OpenWalletUseCase, WalletQueries],
})
export class WalletsModule {}
