import { Inject, Injectable } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/core';
import { Money } from '../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WalletAlreadyExistsError } from '../domain/errors';
import { Wallet } from '../domain/wallet';
import { LEDGER_REPOSITORY, type LedgerRepository } from './ports/ledger-repository';
import { WALLET_REPOSITORY, type WalletRepository } from './ports/wallet-repository';
import { WAGER_TRANSACTION_REPOSITORY, type WagerTransactionRepository } from '../../wagering/application/ports/wager-transaction-repository';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock-port';
import { ID_GENERATOR, type IdGeneratorPort } from '../../shared/application/ports/id-generator-port';
import { ENTITY_MANAGER } from '../../shared/infrastructure/database/database.module';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/**
 * Abre uma wallet. Tudo acontece em UMA transação SQL (§9 do desafio):
 * INSERT wallet + (se saldo > 0) transação interna OPENING (provider
 * 'internal', kind OPENING — nunca submetível por API/fila, imposto no
 * schema) + lançamento CREDIT no ledger.
 *
 * Duplicidade de (playerId, currency) falha com conflito: a UNIQUE
 * uq_wallet_player_currency é a garantia final; a violação é traduzida
 * para WalletAlreadyExistsError (HTTP 409).
 */
@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: LedgerRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactionRepository: WagerTransactionRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENTITY_MANAGER) private readonly em: EntityManager,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const wallet = Wallet.open({
      id: this.ids.newId(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
    });

    try {
      await this.em.transactional(async (tx) => {
        await this.walletRepository.insert(wallet, tx);
        if (command.initialBalance.isPositive()) {
          await this.insertOpening(wallet, command.initialBalance, tx);
        }
      });
    } catch (err) {
      if (isUniqueViolation(err, 'uq_wallet_player_currency')) {
        throw new WalletAlreadyExistsError(
          `wallet already exists for player ${command.playerId} in ${command.initialBalance.currency}`,
        );
      }
      throw err;
    }
    return wallet;
  }

  private async insertOpening(wallet: Wallet, initialBalance: Money, tx: EntityManager): Promise<void> {
    const now = this.clock.now();
    const opening = WagerTransaction.createOpening({
      id: this.ids.newId(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: initialBalance,
      createdAt: now,
    });

    await this.transactionRepository.insert(opening, tx, initialBalance);

    await this.ledgerRepository.insert(
      WalletLedgerEntry.create({
        id: this.ids.newId(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        createdAt: now,
      }),
      tx,
    );
  }
}

/** Interpretação documentada (§16.3 do plano): OPENING não incrementa version — wallet nasce em 1. */

type UniqueViolation = { code?: string; constraint?: string; message?: string };

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as UniqueViolation;
  return (
    e?.code === '23505' &&
    (e?.constraint === constraint || (e?.message?.includes(constraint) ?? false))
  );
}
