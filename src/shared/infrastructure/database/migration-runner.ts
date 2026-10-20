import { type MikroORM } from '@mikro-orm/core';
import { createLogger } from '../logging/logger';

const log = createLogger('migrations');

/**
 * Executa as migrations pendentes. Chamada no bootstrap da aplicação
 * (idempotente) e pelo CLI `bun run migration:up|down`.
 * No bootstrap, falha não derruba o processo: a aplicação sobe e o
 * readiness reporta o problema (o ambiente pode corrigir depois).
 */
export async function runMigrations(orm: MikroORM, options: { optional?: boolean } = {}): Promise<void> {
  try {
    await orm.getMigrator().up();
    log.info('migrations up to date');
  } catch (err) {
    if (options.optional) {
      log.error({ err }, 'failed to run migrations on startup (application continues; readiness will report)');
      return;
    }
    throw err;
  }
}
