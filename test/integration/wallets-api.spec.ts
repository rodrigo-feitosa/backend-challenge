import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { startTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * ET5: API de wallets — criação atômica com OPENING, conflito 409,
 * 400/404 consistentes e paginação estável do ledger.
 */
describe('wallets API (ET5)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let base: string;

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const get = async (path: string): Promise<Response> => fetch(`${base}${path}`);

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

  describe('POST /wallets', () => {
    it('cria wallet com saldo, version=1 e lançamento OPENING CREDIT atômico', async () => {
      const response = await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.version).toBe(1);
      expect(body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(body.id).toBeString();

      // o lançamento da OPENING existe imediatamente (mesma transação SQL)
      const ledger = await get(`/wallets/${body.id}/ledger`);
      expect(ledger.status).toBe(200);
      const page = await ledger.json();
      expect(page.items).toHaveLength(1);
      expect(page.items[0].direction).toBe('CREDIT');
      expect(page.items[0].amount).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(page.items[0].balanceBefore).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(page.items[0].balanceAfter).toEqual({ amount: '1000.00', currency: 'BRL' });

      // a transação OPENING é interna: provider 'internal', kind OPENING, PROCESSED
      const tx = await db.orm.em.getConnection().execute(
        'SELECT kind, provider_id, status FROM wager_transactions WHERE id = ?',
        [page.items[0].transactionId],
      );
      expect(tx[0]).toEqual({ kind: 'OPENING', provider_id: 'internal', status: 'PROCESSED' });
    });

    it('cria wallet com saldo zero sem lançamento OPENING', async () => {
      const response = await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2',
        initialBalance: { amount: '0.00', currency: 'BRL' },
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      const ledger = await get(`/wallets/${body.id}/ledger`);
      expect(((await ledger.json()) as { items: unknown[] }).items).toHaveLength(0);
    });

    it('recusa wallet duplicada (player + moeda) como conflito 409', async () => {
      const payload = {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a3',
        initialBalance: { amount: '50.00', currency: 'BRL' },
      };
      expect((await post('/wallets', payload)).status).toBe(201);
      const duplicate = await post('/wallets', payload);
      expect(duplicate.status).toBe(409);
      const body = await duplicate.json();
      expect(body.code).toBe('WALLET_ALREADY_EXISTS');
    });

    it('permite mesmo player em moeda diferente (multi-moeda)', async () => {
      const response = await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a4',
        initialBalance: { amount: '10.00', currency: 'USD' },
      });
      expect(response.status).toBe(201);
    });

    it('recusa payload inválido com 400', async () => {
      expect((await post('/wallets', { playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } })).status).toBe(400);
      expect((await post('/wallets', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a5', initialBalance: { amount: 'abc', currency: 'BRL' } })).status).toBe(400);
      expect((await post('/wallets', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a5', initialBalance: { amount: '-1.00', currency: 'BRL' } })).status).toBe(400);
      expect((await post('/wallets', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a5', initialBalance: { amount: '1.00', currency: 'brl' } })).status).toBe(400);
      expect((await post('/wallets', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a5' })).status).toBe(400);
    });
  });

  describe('GET /wallets/:id', () => {
    it('retorna a wallet existente', async () => {
      const created = await (await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a6',
        initialBalance: { amount: '75.25', currency: 'BRL' },
      })).json();
      const response = await get(`/wallets/${created.id}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.balance).toEqual({ amount: '75.25', currency: 'BRL' });
    });

    it('retorna 404 para wallet inexistente e 400 para id inválido', async () => {
      const notFound = await get('/wallets/01920000-0000-7000-8000-00000000ffff');
      expect(notFound.status).toBe(404);
      expect((await notFound.json()).code).toBe('NOT_FOUND');
      expect((await get('/wallets/not-a-uuid')).status).toBe(400);
    });
  });

  describe('GET /wallets/:id/ledger — cursor estável', () => {
    it('pagina com cursor opaco sem pular nem duplicar itens', async () => {
      const created = await (await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a7',
        initialBalance: { amount: '0.00', currency: 'BRL' },
      })).json();
      const walletId = created.id as string;

      // 7 lançamentos com timestamps crescentes (fixtures SQL com FK)
      const conn = db.orm.em.getConnection();
      for (let i = 1; i <= 7; i++) {
        await conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at, processed_at)
           VALUES (?::uuid, 'internal', ?, ?, repeat('c', 64), ?::uuid, 'player-x', '', '', 'OPENING', 'PROCESSED',
             100, 'BRL', ?::timestamptz, ?::timestamptz)`,
          [`01920000-0000-7000-8000-00000000000${i}`, `ext-${i}`, `ext-${i}`, walletId,
           new Date(Date.UTC(2026, 0, 1, 12, 0, i)), new Date(Date.UTC(2026, 0, 1, 12, 0, i))],
        );
        await conn.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_cents,
             balance_before_cents, balance_after_cents, created_at)
           VALUES (?::uuid, ?::uuid, ?::uuid, 'CREDIT', 100, 0, 100, ?::timestamptz)`,
          [`01921000-0000-7000-8000-00000000000${i}`, walletId,
           `01920000-0000-7000-8000-00000000000${i}`,
           new Date(Date.UTC(2026, 0, 1, 12, 0, i))],
        );
      }

      const collect = async (limit: number): Promise<{ ids: string[]; pages: number; lastCursor: string | null }> => {
        const ids: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const url = `/wallets/${walletId}/ledger?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page = await (await get(url)).json();
          pages += 1;
          ids.push(...page.items.map((i: { id: string }) => i.id));
          cursor = page.nextCursor;
        } while (cursor);
        return { ids, pages, lastCursor: cursor };
      };

      // paginação de 3 em 3 cobre os 7 fixtures (wallet com saldo 0 = sem OPENING)
      const { ids, pages } = await collect(3);
      expect(ids).toHaveLength(7);
      expect(pages).toBe(3);
      expect(new Set(ids).size).toBe(7);

      // em ordem cronológica estável (created_at, id)
      const ordered = await get(`/wallets/${walletId}/ledger?limit=100`);
      const all = (await ordered.json()).items;
      const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      expect(all.map((i: { id: string }) => i.id)).toEqual(sorted.map((i: { id: string }) => i.id));
    });

    it('recusa limit e cursor inválidos com 400', async () => {
      const created = await (await post('/wallets', {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a8',
        initialBalance: { amount: '0.00', currency: 'BRL' },
      })).json();
      expect((await get(`/wallets/${created.id}/ledger?limit=0`)).status).toBe(400);
      expect((await get(`/wallets/${created.id}/ledger?limit=101`)).status).toBe(400);
      expect((await get(`/wallets/${created.id}/ledger?cursor=lixo`)).status).toBe(400);
    });
  });
});
