import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createWallet,
  playerIdFrom,
  startTestApp,
  submitTransaction,
  type TestApp,
} from '../support/test-app';
import { assertWalletLedgerInvariant } from '../support/invariants';

/**
 * C1 (seção 13): a mesma aposta enviada 50 vezes EM PARALELO →
 * exatamente um débito.
 *
 * C1a: mesma idempotency key → 1 PROCESSED + 49 replays (200),
 *      todos com o mesmo saldo (snapshot da época).
 * C1b: 50 keys distintas, mesmo valor → 1 PROCESSED + 49 REJECTED
 *      (INSUFFICIENT_FUNDS) — o lock serializa e o saldo não permite.
 */
describe('C1 — mesma aposta 50x em paralelo', () => {
  let testApp: TestApp;
  let base: string;

  beforeAll(async () => {
    testApp = await startTestApp();
    base = testApp.baseUrl;
  }, 90_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  it('C1a: mesma key 50x → 1 débito, 49 replays idênticos', async () => {
    const walletId = await createWallet(base, playerIdFrom('c1a00000001'), '100.00');
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'c1a-bet',
      playerId: playerIdFrom('c1a00000001'),
      walletId,
      roundId: 'round-c1a',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submitTransaction(base, body, 'provider-a:c1a-bet')),
    );
    const payloads = await Promise.all(responses.map((r) => r.json() as Promise<Record<string, unknown>>));

    const processed = payloads.filter((p) => p.status === 'PROCESSED' && p.idempotentReplay === false);
    const replays = payloads.filter((p) => p.status === 'PROCESSED' && p.idempotentReplay === true);
    expect(processed.length).toBe(1);
    expect(replays.length).toBe(49);

    // todos os 50 receberam o mesmo saldo (o da época do processamento)
    const balances = new Set(payloads.map((p) => JSON.stringify(p.balance)));
    expect(balances.size).toBe(1);
    expect(processed[0]!.balance).toEqual({ amount: '70.00', currency: 'BRL' });

    // exatamente 1 débito no ledger
    const invariant = await assertWalletLedgerInvariant(base, walletId, 'C1a');
    expect(invariant.balance).toBe('70.00');
    expect(invariant.entries).toBe(2); // OPENING + 1 DEBIT

    // todas as transações compartilham a mesma id (mesma key)
    const txIds = new Set(payloads.map((p) => p.transactionId));
    expect(txIds.size).toBe(1);
  }, 60_000);

  it('C1b: 50 keys distintas, valor 80 sobre saldo 100 → 1 PROCESSED + 49 REJECTED', async () => {
    const walletId = await createWallet(base, playerIdFrom('c1b00000001'), '100.00');
    const player = playerIdFrom('c1b00000001');

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        submitTransaction(
          base,
          {
            providerId: 'provider-a',
            externalTransactionId: `c1b-bet-${i}`,
            playerId: player,
            walletId,
            roundId: 'round-c1b',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '80.00', currency: 'BRL' },
          },
          `provider-a:c1b-bet-${i}`,
        ),
      ),
    );
    const payloads = await Promise.all(responses.map((r) => r.json() as Promise<Record<string, unknown>>));

    const processed = payloads.filter((p) => p.status === 'PROCESSED');
    const rejected = payloads.filter((p) => p.status === 'REJECTED');
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(49);
    expect(rejected.every((p) => p.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(processed[0]!.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    // exatamente 1 débito; nenhum retry duplicou
    const invariant = await assertWalletLedgerInvariant(base, walletId, 'C1b');
    expect(invariant.balance).toBe('20.00');
    expect(invariant.entries).toBe(2); // OPENING + 1 DEBIT
  }, 60_000);
});
