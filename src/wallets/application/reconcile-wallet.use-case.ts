import { Inject, Injectable } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { NotFoundError } from '../../shared/domain/errors';
import { createLogger } from '../../shared/infrastructure/logging/logger';
import { metrics } from '../../shared/infrastructure/metrics/metrics';
import { WALLET_REPOSITORY, type WalletRepository } from './ports/wallet-repository';
import { LEDGER_REPOSITORY, type LedgerRepository } from './ports/ledger-repository';
import { ENTITY_MANAGER } from '../../shared/infrastructure/database/database.module';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const log = createLogger('reconciliation');

/**
 * Reconciliação (§9): compara o saldo armazenado da wallet com o saldo
 * reconstruído pelo ledger (Σ créditos − Σ débitos) em leitura consistente.
 *
 * Divergências NUNCA são corrigidas silenciosamente: são logadas (JSON
 * estruturado), contabilizadas em métrica e sinalizadas na resposta
 * com consistent: false. O endpoint é um relatório — retorna 200 mesmo
 * divergente.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const em = this.em.fork();
    const wallet = await this.wallets.findById(walletId, em);
    if (!wallet) {
      throw new NotFoundError(`wallet ${walletId} not found`);
    }

    const aggregate = await this.ledger.aggregateByWallet(walletId, em);
    const stored = wallet.balance;
    const calculated = Money.fromCents(aggregate.sumCents, wallet.currency);
    const difference = calculated.subtract(stored);
    const consistent = difference.isZero();

    if (!consistent) {
      metrics.incReconciliationDivergence();
      log.warn(
        {
          walletId,
          storedBalance: stored.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          checkedEntries: aggregate.entries,
        },
        'wallet reconciliation divergence detected',
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: aggregate.entries,
    };
  }
}
