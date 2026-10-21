import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWallet, playerIdFrom, startTestApp, submitTransaction, type TestApp } from '../support/test-app';
import { assertWalletLedgerInvariant } from '../support/invariants';

/**
 * C7 (seção 13): ROLLBACK entregue ANTES da referência → PENDING_REFERENCE
 * (regra 7.8) → quando a referência aparece, o worker reprocessa e aplica.
 */
describe('C7 — ROLLBACK antes da referência', () => {
  let app: TestApp;
  let base: string;

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15000, intervalMs = 250): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met within timeout');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  const balance = async (walletId: string): Promise<string> => {
    const res = await fetch(`${base}/wallets/${walletId}`);
    return ((await res.json()) as { balance: { amount: string } }).balance.amount;
  };

  beforeAll(async () => {
    app = await startTestApp({
      WORKERS_ENABLED: 'true',
      PENDING_REF_POLL_INTERVAL_MS: '300',
      PENDING_REF_BASE_DELAY_MS: '200',
      PENDING_REF_MAX_ATTEMPTS: '10',
      PENDING_REF_TTL_HOURS: '24',
    });
    base = app.baseUrl;
  }, 90000);

  afterAll(async () => {
    await app?.stop();
  }, 30000);

  it('ROLLBACK chega primeiro (202), BET chega depois, worker resolve → PROCESSED com crédito', async () => {
    const player = playerIdFrom('c70000000001');
    const walletId = await createWallet(base, player, '100.00');

    // 1. ROLLBACK chega antes da BET — referência inexistente
    const rollback = await submitTransaction(
      base,
      {
        providerId: 'provider-a',
        externalTransactionId: 'c7-rollback',
        playerId: player,
        walletId,
        roundId: 'round-c7',
        gameId: 'fortune-chimp',
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'c7-bet',
      },
      'provider-a:c7-rollback',
    );
    expect(rollback.status).toBe(202);
    expect(((await rollback.json()) as { status: string }).status).toBe('PENDING_REFERENCE');
    expect(await balance(walletId)).toBe('100.00'); // nada mudou

    // 2. a BET referenciada chega depois e é processada
    const bet = await submitTransaction(
      base,
      {
        providerId: 'provider-a',
        externalTransactionId: 'c7-bet',
        playerId: player,
        walletId,
        roundId: 'round-c7',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      },
      'provider-a:c7-bet',
    );
    expect(bet.status).toBe(200);
    expect(await balance(walletId)).toBe('60.00');

    // 3. o worker reprocessa o ROLLBACK e aplica o crédito (40 de volta)
    await waitFor(async () => (await balance(walletId)) === '100.00');

    const rollbackState = await (await fetch(`${base}/providers/provider-a/wagering/transactions/c7-rollback`)).json();
    expect(rollbackState.status).toBe('PROCESSED');
    expect(rollbackState.referenceTransactionId).toBeTruthy();

    const invariant = await assertWalletLedgerInvariant(base, walletId, 'C7');
    expect(invariant.balance).toBe('100.00');
  }, 30000);

  it('referência que nunca chega: permanece PENDING_REFERENCE com tentativas agendadas', async () => {
    const player = playerIdFrom('c70000000002');
    const walletId = await createWallet(base, player, '100.00');

    const refund = await submitTransaction(
      base,
      {
        providerId: 'provider-a',
        externalTransactionId: 'c7-refund-never',
        playerId: player,
        walletId,
        roundId: 'round-c7',
        gameId: 'fortune-chimp',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'c7-never-arrives',
      },
      'provider-a:c7-refund-never',
    );
    expect(refund.status).toBe(202);

    await new Promise((r) => setTimeout(r, 1500)); // alguns ciclos do worker
    const state = await (await fetch(`${base}/providers/provider-a/wagering/transactions/c7-refund-never`)).json();
    expect(state.status).toBe('PENDING_REFERENCE');
    expect(await balance(walletId)).toBe('100.00');
  });
});
