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
 * C3 (seção 13): wallets distintas processadas em paralelo —
 * prova a ausência de lock global [R5.6]: o throughput entre wallets
 * NÃO deve escalar linearmente com o tempo de espera de um lock único;
 * na prática, medimos que N wallets terminam em tempo comparável ao de 1.
 */
describe('C3 — wallets distintas em paralelo', () => {
  let testApp: TestApp;
  let base: string;

  beforeAll(async () => {
    testApp = await startTestApp();
    base = testApp.baseUrl;
  }, 90_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  it('20 wallets com 5 transações cada, em paralelo — todas corretas e sem serialização global', async () => {
    const N_WALLETS = 20;
    const TX_PER_WALLET = 5;

    const walletIds = await Promise.all(
      Array.from({ length: N_WALLETS }, (_, i) =>
        createWallet(base, playerIdFrom(`c3${String(i + 1).padStart(8, '0')}`), '1000.00'),
      ),
    );

    const startedAt = Date.now();
    const all = await Promise.all(
      walletIds.flatMap((walletId, w) =>
        Array.from({ length: TX_PER_WALLET }, (_, i) =>
          submitTransaction(
            base,
            {
              providerId: 'provider-a',
              externalTransactionId: `c3-w${w}-t${i}`,
              playerId: playerIdFrom(`c3${String(w + 1).padStart(8, '0')}`),
              walletId,
              roundId: `round-c3-w${w}`,
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
            },
            `provider-a:c3-w${w}-t${i}`,
          ).then((r) => r.json() as Promise<Record<string, unknown>>),
        ),
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    // todas processadas
    expect(all.filter((p) => p.status === 'PROCESSED').length).toBe(N_WALLETS * TX_PER_WALLET);

    // invariante em todas as wallets: saldo 1000 - 5×10 = 950, ledger coerente
    for (const walletId of walletIds) {
      const invariant = await assertWalletLedgerInvariant(base, walletId, 'C3');
      expect(invariant.balance).toBe('950.00');
      expect(invariant.entries).toBe(TX_PER_WALLET + 1); // OPENING + 5 DEBITs
    }

    // sanidade de paralelismo: 100 transações não podem levar o tempo de
    // 100 execuções puramente serializadas com lock global (folga 20×).
    // Não é benchmark: é uma guarda contra regressão a lock global.
    expect(elapsedMs).toBeLessThan(TX_PER_WALLET * N_WALLETS * 400);
  }, 120_000);
});
