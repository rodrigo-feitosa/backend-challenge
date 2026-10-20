import { Migration } from '@mikro-orm/migrations';

/**
 * Ajuste do ck_reference_required: o enunciado (§7) permite que WIN
 * referencie a BET da mesma rodada (referência opcional); a migration
 * inicial proibia referência para qualquer kind fora REFUND/ROLLBACK.
 *
 * Nova regra:
 * - REFUND/ROLLBACK: referência OBRIGATÓRIA (regra 7.1);
 * - WIN: referência opcional;
 * - BET/LOSS/OPENING: sem referência.
 */
export class Migration20260802000000 extends Migration {
  override async up(): Promise<void> {
    await this.execute(`ALTER TABLE wager_transactions DROP CONSTRAINT ck_reference_required`);
    await this.execute(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_reference_required CHECK (
        (kind IN ('REFUND','ROLLBACK')) = (reference_external_tx_id IS NOT NULL)
        OR (kind = 'WIN')
      )
    `);
  }

  override async down(): Promise<void> {
    await this.execute(`ALTER TABLE wager_transactions DROP CONSTRAINT ck_reference_required`);
    await this.execute(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_reference_required CHECK (
        (kind IN ('REFUND','ROLLBACK')) = (reference_external_tx_id IS NOT NULL)
      )
    `);
  }
}
