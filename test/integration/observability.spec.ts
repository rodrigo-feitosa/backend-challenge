import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWallet, playerIdFrom, startTestApp, submitTransaction, type TestApp } from '../support/test-app';

/**
 * ET15 (seção 12): /metrics expõe todas as séries exigidas e os contadores
 * reagem ao fluxo real (transação, replay de idempotência, divergência de
 * reconciliação). O middleware de correlação devolve o header na resposta.
 */

/** Valor atual de uma série do texto Prometheus (0 se sem amostra). */
function metricValue(text: string, name: string, labels: string): number {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(labels === '' ? `${name} ` : `${name}{${labels}} `));
  if (!line) return 0;
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('ET15 — observabilidade', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  }, 90000);

  afterAll(async () => {
    await app?.stop();
  }, 30000);

  it('/metrics responde com o content-type Prometheus e todas as séries', async () => {
    const res = await fetch(`${app.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const text = await res.text();
    for (const series of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'dlq_messages_total',
      'lock_conflicts_total',
      'lock_wait_seconds',
      'outbox_lag_seconds',
      'outbox_dead_total',
      'processing_latency_seconds',
      'wallet_reconciliation_divergences_total',
    ]) {
      expect(text).toContain(`# HELP ${series} `);
      expect(text).toContain(`# TYPE ${series} `);
    }
  });

  it('contadores acompanham o fluxo real: transação, replay e latência', async () => {
    const before = await (await fetch(`${app.baseUrl}/metrics`)).text();

    const player = playerIdFrom('15000000001');
    const walletId = await createWallet(app.baseUrl, player, '100.00');

    const bet = await submitTransaction(
      app.baseUrl,
      {
        providerId: 'provider-a',
        externalTransactionId: 'et15-bet-1',
        playerId: player,
        walletId,
        roundId: 'round-et15',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      'provider-a:et15-bet-1',
    );
    expect(bet.status).toBe(200);

    // replay do mesmo payload/key: duplicata detectada no canal HTTP
    const replay = await submitTransaction(
      app.baseUrl,
      {
        providerId: 'provider-a',
        externalTransactionId: 'et15-bet-1',
        playerId: player,
        walletId,
        roundId: 'round-et15',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      'provider-a:et15-bet-1',
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

    const after = await (await fetch(`${app.baseUrl}/metrics`)).text();

    expect(
      metricValue(after, 'wager_transactions_total', 'status="PROCESSED",provider="provider-a",kind="BET"') -
        metricValue(before, 'wager_transactions_total', 'status="PROCESSED",provider="provider-a",kind="BET"'),
    ).toBeGreaterThanOrEqual(1);

    expect(
      metricValue(after, 'wager_duplicates_total', 'channel="http"') - metricValue(before, 'wager_duplicates_total', 'channel="http"'),
    ).toBeGreaterThanOrEqual(1);

    expect(
      metricValue(after, 'processing_latency_seconds_count', 'channel="http"') -
        metricValue(before, 'processing_latency_seconds_count', 'channel="http"'),
    ).toBeGreaterThanOrEqual(1);

    // lock pessimista da wallet foi adquirido ao menos uma vez
    expect(
      metricValue(after, 'lock_wait_seconds_count', '') - metricValue(before, 'lock_wait_seconds_count', ''),
    ).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('divergência de reconciliação incrementa wallet_reconciliation_divergences_total', async () => {
    const before = await (await fetch(`${app.baseUrl}/metrics`)).text();
    const beforeValue = metricValue(before, 'wallet_reconciliation_divergences_total', '');

    const player = playerIdFrom('15000000002');
    const walletId = await createWallet(app.baseUrl, player, '50.00');

    // divergência forçada: saldo sobe sem lançamento no ledger
    await app.db.orm.em.fork().getConnection().execute(`UPDATE wallets SET balance_cents = balance_cents + 1000 WHERE id = '${walletId}'`);

    const report = (await (await fetch(`${app.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' })).json()) as {
      consistent: boolean;
    };
    expect(report.consistent).toBe(false);

    const after = await (await fetch(`${app.baseUrl}/metrics`)).text();
    expect(metricValue(after, 'wallet_reconciliation_divergences_total', '')).toBeGreaterThanOrEqual(beforeValue + 1);
  }, 30000);

  it('correlationId do header é propagado e devolvido na resposta', async () => {
    const res = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'et15-corr-123' },
      body: JSON.stringify({}),
    });
    expect(res.headers.get('x-correlation-id')).toBe('et15-corr-123');
    // payload vazio → 400/422 de validação, mas o header de correlação está lá
    expect([400, 422]).toContain(res.status);
  });

  it('requisição sem header recebe correlationId gerado', async () => {
    const res = await fetch(`${app.baseUrl}/health/live`);
    const correlationId = res.headers.get('x-correlation-id');
    expect(correlationId).toBeTruthy();
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
