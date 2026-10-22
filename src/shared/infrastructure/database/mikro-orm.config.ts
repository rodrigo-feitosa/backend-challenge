import { defineConfig } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../../migrations';
import { entities } from './entities';

/**
 * Configuração do MikroORM (ADR-001).
 * `defineConfig` (do pacote do driver) fixa o driver PostgreSQL.
 * `connect: false` — a aplicação sobe mesmo com PostgreSQL indisponível;
 * a conexão é estabelecida na primeira operação (o readiness reporta
 * o estado real, e o sistema se recupera quando o PG volta).
 *
 * FUNÇÃO, não constante: o env é lido na inicialização da aplicação —
 * permite que testes apontem DATABASE_URL para o container da suíte
 * antes de criar o AppModule.
 */
export function getMikroOrmConfig() {
  return defineConfig({
    entities,
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:5432/wagering',
    connect: false,
    debug: process.env.LOG_LEVEL === 'debug',
    discovery: { warnWhenNoEntities: false }, // evita ruído se a lista de entidades mudar de ordem
    pool: {
      min: 2,
      max: 20,
    },
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList,
    },
  });
}
