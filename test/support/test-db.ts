import { MikroORM } from '@mikro-orm/core';
import { Client } from 'pg';
import { mikroOrmConfig } from '../../src/shared/infrastructure/database/mikro-orm.config';
import { startContainer, stopContainer } from './docker-harness';

/**
 * Infra real para testes de integração (regra do desafio: nunca mock de PG/SQS).
 * Sobe um PostgreSQL 16 em container próprio da suíte e roda as migrations.
 */
export interface TestDatabase {
  orm: MikroORM;
  containerName: string;
  stop(): Promise<void>;
}

let containerSeq = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera o PostgreSQL aceitar SQL (sem child processes em loop). */
async function waitForPostgres(clientUrl: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    const client = new Client({ connectionString: clientUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await client.end().catch(() => undefined);
      await sleep(250);
    }
  }
  throw new Error(`PostgreSQL não ficou pronto em ${timeoutMs}ms: ${lastError}`);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const containerName = `wagering-test-pg-${process.pid}-${++containerSeq}`;
  const container = await startContainer({
    image: 'postgres:16-alpine',
    name: containerName,
    env: ['POSTGRES_USER=test', 'POSTGRES_PASSWORD=test', 'POSTGRES_DB=wagering_test'],
    internalPort: 5432,
  });
  const clientUrl = `postgresql://test:test@127.0.0.1:${container.hostPort}/wagering_test`;
  await waitForPostgres(clientUrl);
  const orm = await MikroORM.init({
    ...mikroOrmConfig,
    clientUrl,
    connect: false,
    debug: false,
  });
  await orm.getMigrator().up();
  return {
    orm,
    containerName,
    stop: async () => {
      await orm.close(true);
      await stopContainer(containerName);
    },
  };
}
