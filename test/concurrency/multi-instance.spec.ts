import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestDatabase, type TestDatabase } from '../support/test-db';
import { startAppProcess, submitWithRetry, type AppProcessHandle } from '../support/process-harness';
import { assertWalletLedgerInvariant } from '../support/invariants';

/**
 * C4 (seção 13): 3 processos reais simultâneos processando stream misto
 * (mesma wallet + wallets distintas). Invariante do ledger verde, zero
 * débito/crédito duplicado, zero saldo negativo. [R5.8]
 */
describe('C4 — 3 instâncias simultâneas (processos reais)', () => {
  let db: TestDatabase;
  let processes: AppProcessHandle[] = [];
  let baseUrls: string[] = [];

  const HOT_WALLETS = 2;
  const COLD_WALLETS = 8;
  const TX_PER_WALLET = 10;

  beforeAll(async () => {
    db = await startTestDatabase();
    const dbUrl = `postgresql://test:test@127.0.0.1:${db.hostPort}/wagering_test`;
    const env = {
      DATABASE_URL: dbUrl,
      LOG_LEVEL: 'warn',
      CONSUMER_ENABLED: 'false',
      WORKERS_ENABLED: 'false',
    };
    const started = await Promise.all([startAppProcess(env), startAppProcess(env), startAppProcess(env)]);
    processes = started;
    baseUrls = started.map((p) => p.baseUrl);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(processes.map((p) => p.kill('SIGTERM').catch(() => undefined)));
    await db?.stop();
  }, 30_000);

  it('stream misto em 3 processos: todas as wallets consistentes, sem duplicatas', async () => {
    // cria wallets via instância 1
    const walletIds: string[] = [];
    const players: string[] = [];
    for (let i = 0; i < HOT_WALLETS + COLD_WALLETS; i++) {
      const player = `01930000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`;
      const res = await fetch(`${baseUrls[0]}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: player, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      walletIds.push(body.id);
      players.push(player);
    }

    // stream misto: todas as submissões distribuídas round-robin entre as 3 instâncias
    const submissions: Promise<unknown>[] = [];
    let seq = 0;
    for (let w = 0; w < walletIds.length; w++) {
      for (let t = 0; t < TX_PER_WALLET; t++) {
        seq += 1;
        const isHot = w < HOT_WALLETS;
        submissions.push(
          submitWithRetry(
            baseUrls,
            {
              providerId: 'provider-a',
              externalTransactionId: `c4-tx-${seq}`,
              playerId: players[w],
              walletId: walletIds[w],
              roundId: `round-c4-${w}`,
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
            `provider-a:c4-tx-${seq}`,
          ),
        );
        void isHot;
      }
    }

    const results = await Promise.all(submissions);

    // todas as submissões obtiveram resposta definitiva (200/422 via replay ou processamento)
    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);

    // verificação por wallet: saldo esperado, invariante do ledger, reconciliação
    for (let w = 0; w < walletIds.length; w++) {
      const walletId = walletIds[w];
      const invariant = await assertWalletLedgerInvariant(baseUrls[0], walletId, `C4 wallet ${w}`);
      expect(invariant.balance).toBe('90.00'); // 100 - 10 × 1.00
      expect(invariant.entries).toBe(TX_PER_WALLET + 1); // OPENING + 10 debits

      const reconciliation = await (await fetch(`${baseUrls[1]}/wallets/${walletId}/reconciliation`, { method: 'POST' })).json();
      expect((reconciliation as { consistent: boolean }).consistent).toBe(true);
    }
  }, 180_000);
});
