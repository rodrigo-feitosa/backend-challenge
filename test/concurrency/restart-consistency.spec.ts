import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startTestDatabase, type TestDatabase } from '../support/test-db';
import { startAppProcess, submitWithRetry, type AppProcessHandle } from '../support/process-harness';
import { assertWalletLedgerInvariant } from '../support/invariants';

/**
 * C8 (seção 13): reinício do serviço sob carga → consistência final
 * comprovada (invariações do ledger + reconciliação de todas as wallets).
 * Submissões sob morte por SIGKILL no meio do fluxo, com retry entre
 * instâncias usando a MESMA idempotency key (replay seguro).
 */
describe('C8 — reinício sob carga com consistência final', () => {
  let db: TestDatabase;
  let processes: (AppProcessHandle | undefined)[] = [];
  let baseUrls: string[] = [];

  const WALLETS = 12;
  const TX_PER_WALLET = 4;

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
    await Promise.all(processes.map((p) => p?.kill('SIGKILL').catch(() => undefined)));
    await db?.stop();
  }, 30_000);

  it('mata uma instância no meio da carga, reinicia, e o estado final é consistente', async () => {
    // cria as wallets
    const walletIds: string[] = [];
    const players: string[] = [];
    for (let i = 0; i < WALLETS; i++) {
      const player = `01950000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`;
      const res = await fetch(`${baseUrls[0]}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: player, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      });
      expect(res.status).toBe(201);
      walletIds.push(((await res.json()) as { id: string }).id);
      players.push(player);
    }

    // dispara a carga e mata a instância 1 (SIGKILL) durante o processamento
    const submissions: Promise<{ ok: boolean; status?: number }>[] = [];
    let seq = 0;
    for (let w = 0; w < WALLETS; w++) {
      for (let t = 0; t < TX_PER_WALLET; t++) {
        seq += 1;
        submissions.push(
          submitWithRetry(
            baseUrls,
            {
              providerId: 'provider-a',
              externalTransactionId: `c8-tx-${seq}`,
              playerId: players[w],
              walletId: walletIds[w],
              roundId: `round-c8-${w}`,
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
            },
            `provider-a:c8-tx-${seq}`,
            6, // retries extras: a instância pode morrer no meio
          ),
        );
      }
    }

    const allSettled = Promise.all(submissions);

    // mata a instância no meio da carga
    await new Promise((r) => setTimeout(r, 250));
    const victim = processes[1];
    processes[1] = undefined;
    await victim?.kill('SIGKILL');

    // reinicia uma nova instância para substituí-la
    const replacement = await startAppProcess(
      {
        DATABASE_URL: `postgresql://test:test@127.0.0.1:${db.hostPort}/wagering_test`,
        LOG_LEVEL: 'warn',
        CONSUMER_ENABLED: 'false',
        WORKERS_ENABLED: 'false',
      },
      victim?.port,
    );
    processes[1] = replacement;
    baseUrls[1] = replacement.baseUrl;

    const results = await allSettled;
    // todas as submissões chegaram a um desfecho (com replay quando preciso)
    expect(results.every((r) => r.ok)).toBe(true);

    // consistência final: invariante do ledger + reconciliação em TODAS as wallets
    for (let w = 0; w < WALLETS; w++) {
      const walletId = walletIds[w];
      const invariant = await assertWalletLedgerInvariant(baseUrls[0], walletId, `C8 wallet ${w}`);
      // saldo coerente com o número de débitos (100 - 10 × débitos) e nunca negativo
      const debits = invariant.entries - 1;
      expect(debits).toBeGreaterThanOrEqual(0);
      expect(debits).toBeLessThanOrEqual(TX_PER_WALLET);
      const expected = (100 - debits * 10).toFixed(2);
      expect(invariant.balance).toBe(expected);

      const reconciliation = await (await fetch(`${baseUrls[2]}/wallets/${walletId}/reconciliation`, { method: 'POST' })).json();
      expect((reconciliation as { consistent: boolean }).consistent).toBe(true);
    }
  }, 240_000);
});
