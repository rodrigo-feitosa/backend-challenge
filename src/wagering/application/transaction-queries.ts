import { Inject, Injectable } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { NotFoundError } from '../../shared/domain/errors';
import { ENTITY_MANAGER } from '../../shared/infrastructure/database/database.module';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from './ports/wager-transaction-repository';

/**
 * Consultas de transações (§9):
 * - por id interno: GET /wagering/transactions/:transactionId
 * - por provedor + id externo: GET /providers/:providerId/wagering/transactions/:externalTransactionId
 *   (cobre o índice único uq_tx_external)
 */
@Injectable()
export class TransactionQueries {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.transactions.findById(transactionId, this.em.fork());
    if (!tx) {
      throw new NotFoundError(`transaction ${transactionId} not found`);
    }
    return tx;
  }

  async getByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.transactions.findByProviderAndExternalId(providerId, externalTransactionId, this.em.fork());
    if (!tx) {
      throw new NotFoundError(`transaction ${externalTransactionId} not found for provider ${providerId}`);
    }
    return tx;
  }
}
