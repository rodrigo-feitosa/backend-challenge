import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial — todas as invariantes estruturais do desafio [R5.9]:
 * - unicidade: wallet por (player_id, currency); idempotência por
 *   (provider_id, idempotency_key) e (provider_id, external_transaction_id);
 *   um lançamento por transação; sem dupla reversão (índice parcial);
 * - imutabilidade: trigger bloqueia UPDATE/DELETE/TRUNCATE no ledger
 *   (app não muta mesmo sob bug — REVOKE é inefetivo para o owner do banco);
 * - não-negatividade: CHECK em saldos e aritmética verificada no ledger;
 * - OPENING restrito ao provedor interno; referência obrigatória p/ REFUND/ROLLBACK.
 *
 * `CURRENT_USER` no REVOKE/GRANT: o papel que executa a migration é o mesmo
 * que a aplicação usa em runtime (funciona em qualquer ambiente).
 */
export class Migration20260801000000 extends Migration {
  private readonly statements: string[] = [
    `CREATE TABLE wallets (
      id            uuid PRIMARY KEY,
      player_id     varchar(64) NOT NULL,
      currency      char(3) NOT NULL,
      balance_cents bigint NOT NULL CHECK (balance_cents >= 0),
      version       integer NOT NULL CHECK (version >= 1),
      created_at    timestamptz NOT NULL,
      updated_at    timestamptz NOT NULL,
      CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
    )`,

    `CREATE TABLE wager_transactions (
      id                              uuid PRIMARY KEY,
      provider_id                     varchar(64) NOT NULL,
      external_transaction_id         varchar(128) NOT NULL,
      idempotency_key                 varchar(192) NOT NULL,
      payload_hash                    char(64) NOT NULL,
      wallet_id                       uuid NOT NULL REFERENCES wallets(id),
      player_id                       varchar(64) NOT NULL,
      round_id                        varchar(128) NOT NULL,
      game_id                         varchar(128) NOT NULL,
      kind                            varchar(16) NOT NULL
        CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      status                          varchar(20) NOT NULL
        CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      amount_cents                    bigint NOT NULL CHECK (amount_cents >= 0),
      currency                        char(3) NOT NULL,
      reference_external_tx_id        varchar(128),
      reference_transaction_id        uuid,
      balance_after_cents             bigint,
      balance_after_currency          char(3),
      failure_code                    varchar(64),
      pending_reference_attempts      integer NOT NULL DEFAULT 0,
      pending_reference_next_retry_at timestamptz,
      created_at                      timestamptz NOT NULL,
      processed_at                    timestamptz,
      CONSTRAINT ck_opening_internal CHECK (
        (kind = 'OPENING' AND provider_id = 'internal' AND status = 'PROCESSED')
        OR (kind <> 'OPENING' AND provider_id <> 'internal')
      ),
      CONSTRAINT ck_reference_required CHECK (
        (kind IN ('REFUND','ROLLBACK')) = (reference_external_tx_id IS NOT NULL)
      ),
      CONSTRAINT uq_tx_idempotency UNIQUE (provider_id, idempotency_key),
      CONSTRAINT uq_tx_external UNIQUE (provider_id, external_transaction_id)
    )`,

    `CREATE UNIQUE INDEX uq_tx_single_revert
      ON wager_transactions (reference_transaction_id, kind)
      WHERE kind IN ('REFUND','ROLLBACK')
        AND status IN ('PROCESSED','PENDING_REFERENCE')`,

    `CREATE INDEX ix_tx_pending_reference
      ON wager_transactions (pending_reference_next_retry_at)
      WHERE status = 'PENDING_REFERENCE'`,

    `CREATE TABLE wallet_ledger_entries (
      id                   uuid PRIMARY KEY,
      wallet_id            uuid NOT NULL REFERENCES wallets(id),
      transaction_id       uuid NOT NULL REFERENCES wager_transactions(id),
      direction            varchar(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
      amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
      balance_before_cents bigint NOT NULL CHECK (balance_before_cents >= 0),
      balance_after_cents  bigint NOT NULL CHECK (balance_after_cents >= 0),
      created_at           timestamptz NOT NULL,
      CONSTRAINT uq_entry_transaction UNIQUE (transaction_id),
      CONSTRAINT ck_entry_arithmetic CHECK (
        (direction = 'DEBIT' AND balance_after_cents = balance_before_cents - amount_cents) OR
        (direction = 'CREDIT' AND balance_after_cents = balance_before_cents + amount_cents)
      )
    )`,

    `CREATE INDEX ix_entry_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at, id)`,

    // Imutabilidade estrutural do ledger [R5.5]. Um REVOKE simples não é
    // efetivo quando a aplicação conecta como owner do banco (privilégios
    // do owner são implícitos e não podem ser revogados). O trigger bloqueia
    // UPDATE/DELETE/TRUNCATE para qualquer role não-superusuário.
    `CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % attempted', TG_OP
          USING ERRCODE = '42501';
      END;
    $$ LANGUAGE plpgsql`,

    `CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()`,

    `CREATE TRIGGER trg_ledger_no_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation()`,

    `CREATE TABLE inbox_messages (
      id            uuid PRIMARY KEY,
      consumer_name varchar(64) NOT NULL,
      message_id    varchar(128) NOT NULL,
      payload_hash  char(64) NOT NULL,
      received_at   timestamptz NOT NULL,
      processed_at  timestamptz,
      CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id)
    )`,

    `CREATE TABLE outbox_messages (
      id              uuid PRIMARY KEY,
      aggregate_id    varchar(64) NOT NULL,
      event_type      varchar(64) NOT NULL,
      version         integer NOT NULL,
      payload         jsonb NOT NULL,
      occurred_at     timestamptz NOT NULL,
      status          varchar(12) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PUBLISHED','DEAD')),
      attempts        integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      published_at    timestamptz,
      correlation_id  varchar(64) NOT NULL,
      causation_id    varchar(64)
    )`,

    `CREATE INDEX ix_outbox_polling ON outbox_messages (next_attempt_at) WHERE status = 'PENDING'`,
  ];

  override async up(): Promise<void> {
    for (const sql of this.statements) {
      await this.execute(sql);
    }
  }

  override async down(): Promise<void> {
    await this.execute(`DROP INDEX IF EXISTS ix_outbox_polling`);
    await this.execute(`DROP TABLE IF EXISTS outbox_messages`);
    await this.execute(`DROP TABLE IF EXISTS inbox_messages`);
    await this.execute(`DROP INDEX IF EXISTS ix_entry_wallet_cursor`);
    await this.execute(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    await this.execute(`DROP FUNCTION IF EXISTS prevent_ledger_mutation()`);
    await this.execute(`DROP INDEX IF EXISTS ix_tx_pending_reference`);
    await this.execute(`DROP INDEX IF EXISTS uq_tx_single_revert`);
    await this.execute(`DROP TABLE IF EXISTS wager_transactions`);
    await this.execute(`DROP TABLE IF EXISTS wallets`);
  }
}
