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
 * C2 — cenário OBRIGATÓRIO da seção 8 do desafio:
 * Saldo inicial 100.00 BRL. Duas apostas de 80.00 BRL processadas
 * simultaneamente.
 * Resultado esperado:
 * - exatamente uma aposta PROCESSED;
 * - a outra REJECTED por saldo insuficiente;
 * - saldo final 20.00 BRL;
 * - exatamente UM lançamento de débito no ledger;
 * - nenhum retry duplica o débito.
 */
describe('C2 — cenário obrigatório: 2×80.00 sobre 100.00', () => {
  let testApp: TestApp;
  let base: string;

  beforeAll(async () => {
    testApp = await startTestApp();
    base = testApp.baseUrl;
  }, 90_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  for (let attempt = 1; attempt <= 5; attempt++) {
    it(`disputa simultânea (execução ${attempt}/5 para determinismo)`, async () => {
      const player = playerIdFrom(`c2${String(attempt).padStart(8, '0')}`);
      const walletId = await createWallet(base, player, '100.00');

      const makeBet = (n: number): Promise<Response> =>
        submitTransaction(
          base,
          {
            providerId: 'provider-a',
            externalTransactionId: `c2-bet-${attempt}-${n}`,
            playerId: player,
            walletId,
            roundId: 'round-c2',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '80.00', currency: 'BRL' },
          },
          `provider-a:c2-bet-${attempt}-${n}`,
        );

      const [a, b] = await Promise.all([makeBet(1), makeBet(2)]);
      const pa = (await a.json()) as Record<string, unknown>;
      const pb = (await b.json()) as Record<string, unknown>;
      if (a.status !== 200 || b.status !== 200) {
        console.error('C2 DEBUG a:', a.status, JSON.stringify(pa));
        console.error('C2 DEBUG b:', b.status, JSON.stringify(pb));
      }

      const statuses = [pa.status, pb.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const winner = pa.status === 'PROCESSED' ? pa : pb;
      expect(winner.balance).toEqual({ amount: '20.00', currency: 'BRL' });

      // saldo final 20.00
      const invariant = await assertWalletLedgerInvariant(base, walletId, 'C2');
      expect(invariant.balance).toBe('20.00');
      // exatamente um lançamento de débito (OPENING + 1 DEBIT)
      expect(invariant.entries).toBe(2);
    }, 30_000);
  }
});
