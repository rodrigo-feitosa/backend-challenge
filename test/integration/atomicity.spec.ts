import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { MikroLedgerRepository } from '../../src/wallets/infrastructure/mikro-ledger.repository';
import { MikroOutboxRepository } from '../../src/messaging/infrastructure/mikro-outbox.repository';
import { MikroInboxRepository } from '../../src/messaging/infrastructure/mikro-inbox.repository';
import { MikroWagerTransactionRepository } from '../../src/wagering/infrastructure/mikro-wager-transaction.repository';
import { MikroWalletRepository } from '../../src/wallets/infrastructure/mikro-wallet.repository';
import { SystemClock, UuidV7Generator } from '../../src/shared/infrastructure/id-clock.providers';
import type { ClockPort } from '../../src/shared/application/ports/clock-port';
import { OpenWalletUseCase } from '../../src/wallets/application/open-wallet.use-case';
import {
  SubmitWagerTransactionUseCase,
  type ExecutionContext,
  type SubmitWagerCommand,
} from '../../src/wagering/application/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';
import { startTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * I2 (seção 13): atomicidade entre wallet, ledger, transação e outbox.
 * Uma falha injetada em qualquer ponto da transação derruba TUDO —
 * nada fica parcialmente persistido (§11 do desafio).
 */
describe('atomicidade wallet+ledger+transação+outbox (I2)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let seq = 0;

  const ctx: ExecutionContext = { source: 'HTTP', correlationId: 'test-correlation' };

  /** Relógio que lança na N-ésima chamada — injeta falha em pontos distintos da transação. */
  class ThrowingClock implements ClockPort {
    private calls = 0;
    constructor(private readonly failAfter: number) {}
    now(): Date {
      this.calls += 1;
      if (this.calls > this.failAfter) {
        throw new Error(`injected clock failure after ${this.failAfter} calls`);
      }
      return new Date('2026-02-01T12:00:00.000Z');
    }
  }

  function buildSubmit(failAfter: number): SubmitWagerTransactionUseCase {
    return new SubmitWagerTransactionUseCase(
      new MikroWagerTransactionRepository(),
      new MikroWalletRepository(),
      new MikroOutboxRepository(),
      new MikroInboxRepository(),
      new UuidV7Generator(),
      new ThrowingClock(failAfter),
      orm.em.fork(),
    );
  }

  async function createWallet(balance: string): Promise<{ walletId: string; playerId: string }> {
    seq += 1;
    const playerId = `01920000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
    const wallet = await new OpenWalletUseCase(
      new MikroWalletRepository(),
      new MikroLedgerRepository(),
      new MikroWagerTransactionRepository(),
      new UuidV7Generator(),
      new SystemClock(),
      orm.em.fork(),
    ).execute({ playerId, initialBalance: Money.from({ amount: balance, currency: 'BRL' }) });
    return { walletId: wallet.id, playerId };
  }

  function betCommand(walletId: string, playerId: string): SubmitWagerCommand {
    return {
      providerId: 'provider-a',
      externalTransactionId: `atomic-${walletId}`,
      idempotencyKey: `provider-a:atomic-${walletId}`,
      playerId,
      walletId,
      roundId: 'round-atomic',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
    };
  }

  async function snapshot(walletId: string): Promise<{ balance: number; ledger: number; txs: number; outbox: number }> {
    const em = orm.em.fork();
    const wallet = await em.execute(`SELECT balance_cents FROM wallets WHERE id = ?::uuid`, [walletId]);
    const ledger = await em.execute(`SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = ?::uuid`, [walletId]);
    const txs = await em.execute(`SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = ?::uuid`, [walletId]);
    const outbox = await em.execute(`SELECT COUNT(*) AS n FROM outbox_messages WHERE aggregate_id = ?`, [walletId]);
    return {
      balance: Number.parseInt((wallet[0] as { balance_cents: string }).balance_cents, 10),
      ledger: Number.parseInt((ledger[0] as { n: string }).n, 10),
      txs: Number.parseInt((txs[0] as { n: string }).n, 10),
      outbox: Number.parseInt((outbox[0] as { n: string }).n, 10),
    };
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    orm = db.orm;
  }, 90_000);

  afterAll(async () => {
    await db?.stop();
  }, 30_000);

  it('caso feliz: wallet, ledger, transação e outbox persistem juntos', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const submit = buildSubmit(999); // relógio nunca falha
    const result = await submit.execute(betCommand(walletId, playerId), ctx);

    expect(result.outcome).toBe('PROCESSED');
    const state = await snapshot(walletId);
    expect(state.balance).toBe(6000); // 100 - 40
    expect(state.ledger).toBe(2); // OPENING + DEBIT
    expect(state.txs).toBe(2); // OPENING + BET
    expect(state.outbox).toBe(2); // Processed + WalletBalanceChanged

    const events = await orm.em.fork().execute(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`, [walletId]);
    const types = (events as { event_type: string }[]).map((r) => r.event_type).sort();
    expect(types).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const payloads = await orm.em.fork().execute(
      `SELECT payload FROM outbox_messages WHERE event_type = 'WalletBalanceChanged' AND aggregate_id = ?`,
      [walletId],
    );
    const payload = (payloads[0] as { payload: { data: { balanceBefore: { amount: string }; balanceAfter: { amount: string } } } }).payload;
    expect(payload.data.balanceBefore.amount).toBe('100.00');
    expect(payload.data.balanceAfter.amount).toBe('60.00');
  });

  for (const failAfter of [1, 2, 3]) {
    it(`falha do relógio após ${failAfter} chamada(s) → nada persiste`, async () => {
      const { walletId, playerId } = await createWallet('100.00');
      const before = await snapshot(walletId);
      expect(before.balance).toBe(10000);

      const submit = buildSubmit(failAfter);
      let failed = false;
      try {
        await submit.execute(betCommand(walletId, playerId), ctx);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // nada mudou: nem wallet, nem ledger, nem transação, nem outbox
      const after = await snapshot(walletId);
      expect(after).toEqual(before);
    });
  }

  it('falha na gravação da outbox (última operação antes do commit) → nada persiste', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const before = await snapshot(walletId);

    class FailingOutboxRepository extends MikroOutboxRepository {
      override async enqueue(): Promise<void> {
        throw new Error('injected outbox failure');
      }
      override async enqueueMany(): Promise<void> {
        throw new Error('injected outbox failure');
      }
    }

    const submit = new SubmitWagerTransactionUseCase(
      new MikroWagerTransactionRepository(),
      new MikroWalletRepository(),
      new FailingOutboxRepository(),
      new MikroInboxRepository(),
      new UuidV7Generator(),
      new SystemClock(),
      orm.em.fork(),
    );

    await expect(submit.execute(betCommand(walletId, playerId), ctx)).rejects.toThrow('injected outbox failure');

    const after = await snapshot(walletId);
    expect(after).toEqual(before);
  });
});
