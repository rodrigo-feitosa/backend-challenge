import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWallet, playerIdFrom, startTestApp, submitTransaction, type TestApp } from '../support/test-app';

/**
 * ET9: consultas por id/provedor e reconciliação com relatório honesto.
 */
describe('queries and reconciliation (ET9)', () => {
  let testApp: TestApp;
  let base: string;

  beforeAll(async () => {
    testApp = await startTestApp();
    base = testApp.baseUrl;
  }, 90_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  describe('GET /wagering/transactions/:id', () => {
    it('retorna a transação por id interno e por provider+external', async () => {
      const player = playerIdFrom('e19a00000001');
      const walletId = await createWallet(base, player, '100.00');
      const res = await submitTransaction(
        base,
        {
          providerId: 'provider-a',
          externalTransactionId: 'et9-tx-1',
          playerId: player,
          walletId,
          roundId: 'round-et9',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
        'provider-a:et9-tx-1',
      );
      const created = (await res.json()) as { transactionId: string; status: string };
      expect(res.status).toBe(200);

      const byId = await (await fetch(`${base}/wagering/transactions/${created.transactionId}`)).json();
      expect(byId.transactionId).toBe(created.transactionId);
      expect(byId.status).toBe('PROCESSED');
      expect(byId.kind).toBe('BET');
      expect(byId.amount).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(byId.idempotencyKey).toBe('provider-a:et9-tx-1');

      const byExternal = await (await fetch(`${base}/providers/provider-a/wagering/transactions/et9-tx-1`)).json();
      expect(byExternal.transactionId).toBe(created.transactionId);
    });

    it('404 para transação inexistente', async () => {
      const res = await fetch(`${base}/wagering/transactions/01920000-0000-7000-8000-000000000099`);
      expect(res.status).toBe(404);
      const res2 = await fetch(`${base}/providers/provider-x/wagering/transactions/nope`);
      expect(res2.status).toBe(404);
    });
  });

  describe('POST /wallets/:id/reconciliation', () => {
    it('relata consistência após operações variadas', async () => {
      const player = playerIdFrom('e19b00000001');
      const walletId = await createWallet(base, player, '500.00');
      await submitTransaction(base, {
        providerId: 'provider-a', externalTransactionId: 'et9-r1', playerId: player, walletId,
        roundId: 'r1', gameId: 'g', kind: 'BET', money: { amount: '100.00', currency: 'BRL' },
      }, 'provider-a:et9-r1');
      await submitTransaction(base, {
        providerId: 'provider-a', externalTransactionId: 'et9-r2', playerId: player, walletId,
        roundId: 'r1', gameId: 'g', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' },
      }, 'provider-a:et9-r2');
      await submitTransaction(base, {
        providerId: 'provider-a', externalTransactionId: 'et9-r3', playerId: player, walletId,
        roundId: 'r1', gameId: 'g', kind: 'LOSS', money: { amount: '10.00', currency: 'BRL' },
      }, 'provider-a:et9-r3');

      const res = await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' });
      expect(res.status).toBe(200);
      const report = (await res.json()) as Record<string, unknown>;
      expect(report.walletId).toBe(walletId);
      expect(report.storedBalance).toEqual({ amount: '450.00', currency: 'BRL' });
      expect(report.calculatedBalance).toEqual({ amount: '450.00', currency: 'BRL' });
      expect(report.difference).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(report.consistent).toBe(true);
      expect(report.checkedEntries).toBe(3); // OPENING + BET + WIN (LOSS não gera lançamento)
    });

    it('divergência provocada: relatório honesto (consistent:false), sem correção silenciosa', async () => {
      const player = playerIdFrom('e19c00000001');
      const walletId = await createWallet(base, player, '100.00');

      // corrompe o saldo diretamente no banco (simula bug externo)
      await testApp.db.orm.em.getConnection().execute('UPDATE wallets SET balance_cents = balance_cents + 1000 WHERE id = ?::uuid', [walletId]);

      const res = await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' });
      expect(res.status).toBe(200); // é um relatório: 200 mesmo divergente
      const report = (await res.json()) as Record<string, unknown>;
      expect(report.consistent).toBe(false);
      expect(report.storedBalance).toEqual({ amount: '110.00', currency: 'BRL' });
      expect(report.calculatedBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(report.difference).toEqual({ amount: '-10.00', currency: 'BRL' });

      // restaura: consistência volta
      await testApp.db.orm.em.getConnection().execute('UPDATE wallets SET balance_cents = 10000 WHERE id = ?::uuid', [walletId]);
      const after = (await (await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: 'POST' })).json()) as Record<string, unknown>;
      expect(after.consistent).toBe(true);
    });

    it('404 para wallet inexistente', async () => {
      const res = await fetch(`${base}/wallets/01920000-0000-7000-8000-000000000099/reconciliation`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});
