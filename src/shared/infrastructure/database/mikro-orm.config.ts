import { defineConfig } from '@mikro-orm/postgresql';
import { entities } from './entities';

/**
 * Configuração do MikroORM (ADR-001).
 * `defineConfig` (do pacote do driver) fixa o driver PostgreSQL.
 * `connect: false` — a aplicação sobe mesmo com PostgreSQL indisponível;
 * a conexão é estabelecida na primeira operação (o readiness reporta
 * o estado real, e o sistema se recupera quando o PG volta).
 */
export const mikroOrmConfig = defineConfig({
  entities,
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5432/wagering',
  connect: false,
  debug: process.env.LOG_LEVEL === 'debug',
  discovery: { warnWhenNoEntities: false }, // temporário — ET4 registra as entidades reais
  pool: {
    min: 2,
    max: 20,
  },
  migrations: {
    path: 'migrations',
    pathTs: 'migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
  },
});
