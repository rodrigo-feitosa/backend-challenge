import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { startTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * ET7: submissão de transações — regras da tabela §7, idempotência
 * (replay com snapshot da regra 7.7, conflito de payload) e invariante
 * final saldo == ledger.
 */
describe('submit wager transactions (ET7)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let base: string;

  const postTx = async (body: Record<string, unknown>, key?: string): Promise<Response> =>
    fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });

  const getWallet = async (walletId: string): Promise<{ balance: { amount: string }; version: number }> =>
    (await (await fetch(`${base}/wallets/${walletId}`)).json()) as never;

  const ledgerSum = async (walletId: string): Promise<string> => {
    const res = await fetch(`${base}/wallets/${walletId}/ledger?limit=100`);
    const page = (await res.json()) as { items: { direction: string; amount: { amount: string } }[] };
    let cents = 0n;
    for (const item of page.items) {
      const [int, frac = ''] = item.amount.amount.split('.');
      const value = BigInt(int + frac.padEnd(2, '0'));
      cents += item.direction === 'CREDIT' ? value : -value;
    }
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    process.env.DATABASE_URL = `postgresql://test:test@127.0.0.1:${db.hostPort}/wagering_test`;
    process.env.MIGRATIONS_ON_START = 'false';
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app);
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  const createWallet = async (playerSuffix: string, balance = '100.00'): Promise<{ id: string; playerId: string }> => {
    const playerId = `01920000-0000-7000-8000-${playerSuffix.padStart(12, '0')}`;
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return { id: body.id, playerId };
  };

  const txBody = (wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    providerId: 'provider-a',
    externalTransactionId: 'tx-ext-1',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  });

  describe('BET e idempotência', () => {
    it('processa BET, debita saldo e cria lançamento DEBIT', async () => {
      const wallet = await createWallet('000000000001');
      const res = await postTx(txBody(wallet), 'provider-a:tx-ext-1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('PROCESSED');
      expect(body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(body.idempotentReplay).toBe(false);
    });

    it('replay idêntico devolve o resultado original com o saldo da época (regra 7.7)', async () => {
      const wallet = await createWallet('000000000002');
      const first = await (await postTx(txBody(wallet, { externalTransactionId: 'ext-r1' }), 'provider-a:ext-r1')).json();
      expect(first.balance).toEqual({ amount: '75.00', currency: 'BRL' });

      // saldo muda depois; o replay NÃO deve refletir o saldo atual
      await postTx(txBody(wallet, { externalTransactionId: 'ext-r2', kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } }), 'provider-a:ext-r2');

      const replay = await postTx(txBody(wallet, { externalTransactionId: 'ext-r1' }), 'provider-a:ext-r1');
      expect(replay.status).toBe(200);
      const body = await replay.json();
      expect(body.idempotentReplay).toBe(true);
      expect(body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    });

    it('mesma key com payload diferente é conflito 409, não replay', async () => {
      const wallet = await createWallet('000000000003');
      await postTx(txBody(wallet, { externalTransactionId: 'ext-c1' }), 'provider-a:ext-c1');
      const conflict = await postTx(txBody(wallet, { externalTransactionId: 'ext-c1', money: { amount: '30.00', currency: 'BRL' } }), 'provider-a:ext-c1');
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('ausência do header Idempotency-Key é 400', async () => {
      const wallet = await createWallet('000000000004');
      const res = await postTx(txBody(wallet));
      expect(res.status).toBe(400);
    });
  });

  describe('regras de negócio §7', () => {
    it('BET sem saldo é rejeitada com INSUFFICIENT_FUNDS, sem alterar saldo', async () => {
      const wallet = await createWallet('000000000005', '10.00');
      const res = await postTx(txBody(wallet, { externalTransactionId: 'ext-i1', money: { amount: '50.00', currency: 'BRL' } }), 'provider-a:ext-i1');
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.status).toBe('REJECTED');
      expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect((await getWallet(wallet.id)).balance.amount).toBe('10.00');

      // replay da rejeitada devolve o resultado original (422 + replay flag)
      const replay = await postTx(txBody(wallet, { externalTransactionId: 'ext-i1', money: { amount: '50.00', currency: 'BRL' } }), 'provider-a:ext-i1');
      expect(replay.status).toBe(422);
      expect((await replay.json()).idempotentReplay).toBe(true);
    });

    it('LOSS registra o resultado sem mover saldo nem criar lançamento', async () => {
      const wallet = await createWallet('000000000006');
      const res = await postTx(txBody(wallet, { externalTransactionId: 'ext-l1', kind: 'LOSS' }), 'provider-a:ext-l1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('PROCESSED');
      expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      const page = await (await fetch(`${base}/wallets/${wallet.id}/ledger`)).json();
      expect(page.items).toHaveLength(1); // apenas o OPENING
    });

    it('WIN credita; WIN pode referenciar a BET da mesma rodada', async () => {
      const wallet = await createWallet('000000000007');
      await postTx(txBody(wallet, { externalTransactionId: 'ext-w0' }), 'provider-a:ext-w0'); // BET 25 → 75
      const win = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-w1', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-w0' }),
        'provider-a:ext-w1',
      );
      expect(win.status).toBe(200);
      expect((await win.json()).balance).toEqual({ amount: '125.00', currency: 'BRL' });

      // WIN sem referência também é aceito
      const winNoRef = await postTx(txBody(wallet, { externalTransactionId: 'ext-w2', kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }), 'provider-a:ext-w2');
      expect(winNoRef.status).toBe(200);
    });

    it('WIN com referência de outra rodada é REFERENCE_MISMATCH; referência de LOSS é REFERENCE_INVALID_KIND', async () => {
      const wallet = await createWallet('000000000008');
      await postTx(txBody(wallet, { externalTransactionId: 'ext-x0', roundId: 'round-A' }), 'provider-a:ext-x0');
      await postTx(txBody(wallet, { externalTransactionId: 'ext-xL', kind: 'LOSS', roundId: 'round-B' }), 'provider-a:ext-xL');

      const mismatch = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-x1', kind: 'WIN', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-x0', roundId: 'round-B' }),
        'provider-a:ext-x1',
      );
      expect(mismatch.status).toBe(422);
      expect((await mismatch.json()).failureCode).toBe('REFERENCE_MISMATCH');

      const invalidKind = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-x2', kind: 'WIN', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-xL', roundId: 'round-B' }),
        'provider-a:ext-x2',
      );
      expect(invalidKind.status).toBe(422);
      expect((await invalidKind.json()).failureCode).toBe('REFERENCE_INVALID_KIND');
    });

    it('REFUND reverte a BET uma única vez; valor divergente é rejeitado', async () => {
      const wallet = await createWallet('000000000009');
      await postTx(txBody(wallet, { externalTransactionId: 'ext-f0' }), 'provider-a:ext-f0'); // BET 25 → 75

      const wrongAmount = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-f1', kind: 'REFUND', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-f0' }),
        'provider-a:ext-f1',
      );
      expect(wrongAmount.status).toBe(422);
      expect((await wrongAmount.json()).failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');

      const refund = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-f2', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-f0' }),
        'provider-a:ext-f2',
      );
      expect(refund.status).toBe(200);
      expect((await refund.json()).balance).toEqual({ amount: '100.00', currency: 'BRL' });

      // segunda REFUND da mesma referência é rejeitada (regra 7.4)
      const again = await postTx(
        txBody(wallet, { externalTransactionId: 'ext-f3', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'ext-f0' }),
        'provider-a:ext-f3',
      );
      expect(again.status).toBe(422);
      expect((await again.json()).failureCode).toBe('REFERENCE_ALREADY_REVERTED');
    });

    it('ROLLBACK de BET credita; de WIN e REFUND debita (inverso da referência)', async () => {
      const wallet = await createWallet('00000000000a');
      await postTx(txBody(wallet, { externalTransactionId: 'rb-bet' }), 'provider-a:rb-bet'); // 100-25=75
      await postTx(txBody(wallet, { externalTransactionId: 'rb-win', kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } }), 'provider-a:rb-win'); // 75+30=105
      await postTx(
        txBody(wallet, { externalTransactionId: 'rb-ref', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'rb-bet' }),
        'provider-a:rb-ref',
      ); // 105+25=130

      // ROLLBACK da REFUND (que creditou) → debita 25 → 105
      const rbRefund = await postTx(
        txBody(wallet, { externalTransactionId: 'rb-1', kind: 'ROLLBACK', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'rb-ref' }),
        'provider-a:rb-1',
      );
      expect(rbRefund.status).toBe(200);
      expect((await rbRefund.json()).balance).toEqual({ amount: '105.00', currency: 'BRL' });

      // ROLLBACK da WIN (que creditou) → debita 30 → 75
      const rbWin = await postTx(
        txBody(wallet, { externalTransactionId: 'rb-2', kind: 'ROLLBACK', money: { amount: '30.00', currency: 'BRL' }, referenceExternalTransactionId: 'rb-win' }),
        'provider-a:rb-2',
      );
      expect((await rbWin.json()).balance).toEqual({ amount: '75.00', currency: 'BRL' });

      // ROLLBACK da BET (que debitou) → credita 25 → 100
      const rbBet = await postTx(
        txBody(wallet, { externalTransactionId: 'rb-3', kind: 'ROLLBACK', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'rb-bet' }),
        'provider-a:rb-3',
      );
      expect((await rbBet.json()).balance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('ROLLBACK que negativizaria de fato retorna REVERSAL_WOULD_OVERDRAW (regra 7.9)', async () => {
      const wallet = await createWallet('00000000000c', '10.00');
      await postTx(
        txBody(wallet, { externalTransactionId: 'ov2-win', kind: 'WIN', money: { amount: '20.00', currency: 'BRL' }, roundId: 'round-ov' }),
        'provider-a:ov2-win',
      ); // 30
      // gastar até ficar com menos que 20
      await postTx(
        txBody(wallet, { externalTransactionId: 'ov2-bet', money: { amount: '25.00', currency: 'BRL' }, roundId: 'round-ov' }),
        'provider-a:ov2-bet',
      ); // 5
      const rb = await postTx(
        txBody(wallet, { externalTransactionId: 'ov2-rb', kind: 'ROLLBACK', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: 'ov2-win', roundId: 'round-ov' }),
        'provider-a:ov2-rb',
      );
      expect(rb.status).toBe(422);
      expect((await rb.json()).failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
      expect((await getWallet(wallet.id)).balance.amount).toBe('5.00');
    });

    it('referência inexistente vira PENDING_REFERENCE 202; replay também 202', async () => {
      const wallet = await createWallet('00000000000d');
      const res = await postTx(
        txBody(wallet, { externalTransactionId: 'pd-1', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'nao-existe' }),
        'provider-a:pd-1',
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe('PENDING_REFERENCE');
      expect(body.idempotentReplay).toBe(false);
      expect((await getWallet(wallet.id)).balance.amount).toBe('100.00');

      const replay = await postTx(
        txBody(wallet, { externalTransactionId: 'pd-1', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'nao-existe' }),
        'provider-a:pd-1',
      );
      expect(replay.status).toBe(202);
      expect((await replay.json()).idempotentReplay).toBe(true);
    });

    it('wallet inexistente, player divergente e moeda divergente são rejeições específicas', async () => {
      const wallet = await createWallet('00000000000e');
      const unknown = await postTx(
        txBody(wallet, { externalTransactionId: 'u1', walletId: '01920000-0000-7000-8000-00000000ffff' }),
        'provider-a:u1',
      );
      expect(unknown.status).toBe(422);
      expect((await unknown.json()).failureCode).toBe('WALLET_NOT_FOUND');

      const otherWallet = await createWallet('00000000000f');
      const playerMismatch = await postTx(
        txBody(otherWallet, { externalTransactionId: 'u2', playerId: wallet.playerId }),
        'provider-a:u2',
      );
      expect(playerMismatch.status).toBe(422);
      expect((await playerMismatch.json()).failureCode).toBe('WALLET_PLAYER_MISMATCH');

      const currencyMismatch = await postTx(
        txBody(wallet, { externalTransactionId: 'u3', money: { amount: '10.00', currency: 'USD' } }),
        'provider-a:u3',
      );
      expect(currencyMismatch.status).toBe(422);
      expect((await currencyMismatch.json()).failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('kind OPENING e payload inválido são 400', async () => {
      const wallet = await createWallet('000000000010');
      expect((await postTx(txBody(wallet, { externalTransactionId: 'o1', kind: 'OPENING' }), 'provider-a:o1')).status).toBe(400);
      expect((await postTx(txBody(wallet, { externalTransactionId: 'o2', money: { amount: 'abc', currency: 'BRL' } }), 'provider-a:o2')).status).toBe(400);
      expect((await postTx(txBody(wallet, { externalTransactionId: 'o3', kind: 'DEPOSIT' }), 'provider-a:o3')).status).toBe(400);
    });
  });

  describe('invariante final: saldo == saldo reconstruído pelo ledger', () => {
    it('após sequência completa BET/WIN/LOSS/REFUND/ROLLBACK', async () => {
      const wallet = await createWallet('000000000011', '500.00');
      await postTx(txBody(wallet, { externalTransactionId: 'inv-1', money: { amount: '100.00', currency: 'BRL' } }), 'provider-a:inv-1'); // 400
      await postTx(txBody(wallet, { externalTransactionId: 'inv-2', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }), 'provider-a:inv-2'); // 450
      await postTx(txBody(wallet, { externalTransactionId: 'inv-3', kind: 'LOSS', money: { amount: '10.00', currency: 'BRL' } }), 'provider-a:inv-3'); // 450
      await postTx(
        txBody(wallet, { externalTransactionId: 'inv-4', kind: 'REFUND', money: { amount: '100.00', currency: 'BRL' }, referenceExternalTransactionId: 'inv-1' }),
        'provider-a:inv-4',
      ); // 550
      await postTx(
        txBody(wallet, { externalTransactionId: 'inv-5', kind: 'ROLLBACK', money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: 'inv-2' }),
        'provider-a:inv-5',
      ); // 500
      await postTx(txBody(wallet, { externalTransactionId: 'inv-6', money: { amount: '200.00', currency: 'BRL' } }), 'provider-a:inv-6'); // 300

      const balance = (await getWallet(wallet.id)).balance.amount;
      const ledgerBalance = await ledgerSum(wallet.id);
      expect(balance).toBe('300.00');
      expect(ledgerBalance).toBe('300.00');
    });
  });
});
