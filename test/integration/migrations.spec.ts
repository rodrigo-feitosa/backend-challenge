import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroWalletRepository } from '../../src/wallets/infrastructure/mikro-wallet.repository';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallets/domain/wallet';
import { startTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * I1 (plano §9): migrations up/down/up e TODA violação de constraint
 * falha no PostgreSQL — as invariantes vivem no schema [R5.9].
 */
describe('migrations e constraints (I1)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await db?.stop();
  }, 30_000);

  it('aplica up, reverte com down e reaplica (migrations reversíveis)', async () => {
    const migrator = db.orm.getMigrator();
    const tables = async (): Promise<string[]> => {
      const rows = await db.orm.em.getConnection().execute(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      return (rows as { tablename: string }[]).map((r) => r.tablename);
    };

    expect(await tables()).toContain('wallets');
    while ((await migrator.down()).length > 0) {
      // reverte todas as migrations, uma a uma
    }
    expect(await tables()).not.toContain('wallets');
    await migrator.up();
    expect(await tables()).toContain('wallets');
  }, 30_000);

  describe('violando constraints via SQL — o PostgreSQL deve recusar', () => {
    const exec = async (sql: string, params?: unknown[]): Promise<unknown> =>
      db.orm.em.getConnection().execute(sql, params);

    const expectPgError = async (sql: string, code: string, params?: unknown[]): Promise<void> => {
      try {
        await exec(sql, params);
        throw new Error(`esperava violação ${code}, SQL passou: ${sql}`);
      } catch (err) {
        const pgCode = (err as { code?: string; message?: string }).code;
        if (!pgCode) throw err;
        expect(pgCode).toBe(code);
      }
    };

    beforeAll(async () => {
      // fixtures: uma wallet e uma transação para os testes com FK
      await exec(
        `INSERT INTO wallets (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES ('01920000-0000-7000-8000-000000000001', 'player-a', 'BRL', 100000, 1, now(), now())`,
      );
      await exec(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES ('01920000-0000-7000-8000-0000000000aa', 'provider-a', 'ext-1', 'provider-a:ext-1', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'BET', 'PROCESSED', 2500, 'BRL', now())`,
      );
    });

    it('recusa saldo negativo (CHECK)', async () => {
      await expectPgError(
        `UPDATE wallets SET balance_cents = -1 WHERE player_id = 'player-a'`,
        '23514',
      );
    });

    it('recusa wallet duplicada para player + moeda (UNIQUE)', async () => {
      await expectPgError(
        `INSERT INTO wallets (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (gen_random_uuid(), 'player-a', 'BRL', 0, 1, now(), now())`,
        '23505',
      );
    });

    it('permite mesma player em moeda diferente (multi-moeda)', async () => {
      await exec(
        `INSERT INTO wallets (id, player_id, currency, balance_cents, version, created_at, updated_at)
         VALUES (gen_random_uuid(), 'player-a', 'USD', 0, 1, now(), now())`,
      );
    });

    it('recusa idempotency key duplicada (UNIQUE)', async () => {
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-outro', 'provider-a:ext-1', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'BET', 'PROCESSED', 2500, 'BRL', now())`,
        '23505',
      );
    });

    it('recusa (provider, external_transaction_id) duplicada (UNIQUE)', async () => {
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-1', 'provider-a:ext-outro', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'BET', 'PROCESSED', 2500, 'BRL', now())`,
        '23505',
      );
    });

    it('recusa kind e status inválidos (CHECK)', async () => {
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-2', 'provider-a:ext-2', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'DEPOSIT', 'PROCESSED', 2500, 'BRL', now())`,
        '23514',
      );
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-3', 'provider-a:ext-3', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'BET', 'MAYBE', 2500, 'BRL', now())`,
        '23514',
      );
    });

    it('recusa REFUND/ROLLBACK sem referência e BET com referência (CHECK)', async () => {
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-4', 'provider-a:ext-4', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'REFUND', 'PROCESSED', 2500, 'BRL', now())`,
        '23514',
      );
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency,
           reference_external_tx_id, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-5', 'provider-a:ext-5', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'BET', 'PROCESSED', 2500, 'BRL',
           'ext-1', now())`,
        '23514',
      );
    });

    it('recusa OPENING fora do provedor interno (CHECK)', async () => {
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'ext-6', 'provider-a:ext-6', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'OPENING', 'PROCESSED', 2500, 'BRL', now())`,
        '23514',
      );
    });

    it('recusa dupla reversão do mesmo tipo (índice parcial)', async () => {
      await exec(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency,
           reference_external_tx_id, reference_transaction_id, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'refund-1', 'provider-a:refund-1', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'REFUND', 'PROCESSED', 2500, 'BRL',
           'ext-1', '01920000-0000-7000-8000-0000000000aa', now())`,
      );
      await expectPgError(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, status, amount_cents, currency,
           reference_external_tx_id, reference_transaction_id, created_at)
         VALUES (gen_random_uuid(), 'provider-a', 'refund-2', 'provider-a:refund-2', repeat('a', 64),
           '01920000-0000-7000-8000-000000000001', 'player-a', 'round-1', 'game-1', 'REFUND', 'PROCESSED', 2500, 'BRL',
           'ext-1', '01920000-0000-7000-8000-0000000000aa', now())`,
        '23505',
      );
    });

    it('recusa UPDATE, DELETE e TRUNCATE no ledger (trigger — imutabilidade)', async () => {
      await exec(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (gen_random_uuid(), '01920000-0000-7000-8000-000000000001',
           '01920000-0000-7000-8000-0000000000aa', 'DEBIT', 2500, 100000, 97500, now())`,
      );
      await expectPgError(`UPDATE wallet_ledger_entries SET amount_cents = 1`, '42501');
      await expectPgError(`DELETE FROM wallet_ledger_entries`, '42501');
      await expectPgError(`TRUNCATE wallet_ledger_entries`, '42501');
    });

    it('recusa lançamento com aritmética errada, valor zero e transação duplicada (CHECK/UNIQUE)', async () => {
      await expectPgError(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (gen_random_uuid(), '01920000-0000-7000-8000-000000000001',
           '01920000-0000-7000-8000-0000000000aa', 'DEBIT', 2500, 100000, 90000, now())`,
        '23514',
      );
      await expectPgError(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (gen_random_uuid(), '01920000-0000-7000-8000-000000000001',
           '01920000-0000-7000-8000-0000000000aa', 'DEBIT', 0, 100000, 100000, now())`,
        '23514',
      );
      await expectPgError(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount_cents,
           balance_before_cents, balance_after_cents, created_at)
         VALUES (gen_random_uuid(), '01920000-0000-7000-8000-000000000001',
           '01920000-0000-7000-8000-0000000000aa', 'CREDIT', 100, 97500, 97600, now())`,
        '23505',
      );
    });

    it('recusa mensagem de inbox duplicada para o mesmo consumidor (UNIQUE)', async () => {
      const base = (id: string): string =>
        `INSERT INTO inbox_messages (id, consumer_name, message_id, payload_hash, received_at)
         VALUES ('${id}', 'wager-consumer', 'msg-1', repeat('b', 64), now())`;
      await exec(base('01920000-0000-7000-8000-0000000000b1'));
      await expectPgError(base('01920000-0000-7000-8000-0000000000b2'), '23505');
    });
  });

  describe('round-trip do repositório (Money exato, ADR-002)', () => {
    it('persiste e relê wallet com centavos exatos e entradas pendentes', async () => {
      const em = db.orm.em.fork();
      const repo = new MikroWalletRepository();
      const wallet = Wallet.open({
        id: '01920000-0000-7000-8000-000000000002',
        playerId: 'player-roundtrip',
        initialBalance: Money.from({ amount: '1234.56', currency: 'BRL' }),
      });
      await em.transactional(async (tx) => {
        await repo.insert(wallet, tx);
      });

      const loaded = await repo.findById(wallet.id, em);
      expect(loaded).not.toBeNull();
      expect(loaded!.balance.toCents()).toBe(123456n);
      expect(loaded!.version).toBe(1);
      expect(loaded!.pendingEntries.length).toBe(0);
    });
  });
});
