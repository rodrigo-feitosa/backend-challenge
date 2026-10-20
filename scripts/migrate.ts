import { MikroORM } from '@mikro-orm/core';
import { getMikroOrmConfig } from '../src/shared/infrastructure/database/mikro-orm.config';

/**
 * CLI de migrations: `bun run migration:up` ou `bun run migration:down`.
 * Aplicável também em produção (mesma lista de migrations do app).
 */
const direction = process.argv[2] ?? 'up';

const orm = await MikroORM.init(getMikroOrmConfig());
try {
  const migrator = orm.getMigrator();
  const executed = direction === 'down' ? await migrator.down() : await migrator.up();
  console.log(`${direction} executed:`, executed.map((m) => m.name ?? m));
} finally {
  await orm.close(true);
}
