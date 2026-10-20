import { Inject, Injectable } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { NotFoundError } from '../../shared/domain/errors';
import { Wallet } from '../domain/wallet';
import type { LedgerPage, LedgerRepository } from './ports/ledger-repository';
import { LEDGER_REPOSITORY } from './ports/ledger-repository';
import { WALLET_REPOSITORY, type WalletRepository } from './ports/wallet-repository';
import { ENTITY_MANAGER } from '../../shared/infrastructure/database/database.module';

export interface LedgerQuery {
  walletId: string;
  limit: number;
  cursor?: string | undefined;
}

/**
 * Queries de leitura de wallets e ledger.
 */
@Injectable()
export class WalletQueries {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: LedgerRepository,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.walletRepository.findById(walletId, this.em.fork());
    if (!wallet) {
      throw new NotFoundError(`wallet ${walletId} not found`);
    }
    return wallet;
  }

  async listLedger(query: LedgerQuery): Promise<LedgerPage> {
    // valida existência (404) antes de paginar
    await this.getWallet(query.walletId);
    return this.ledgerRepository.listByWallet(query.walletId, query.limit, query.cursor, this.em.fork());
  }
}
