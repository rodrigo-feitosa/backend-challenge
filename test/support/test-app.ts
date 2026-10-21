import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { startTestDatabase, type TestDatabase } from './test-db';

/**
 * App NestJS real + banco real, para testes de integração e de concorrência.
 */
export interface TestApp {
  db: TestDatabase;
  app: INestApplication;
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startTestApp(env?: Record<string, string>): Promise<TestApp> {
  const db = await startTestDatabase();
  process.env.DATABASE_URL = `postgresql://test:test@127.0.0.1:${db.hostPort}/wagering_test`;
  process.env.MIGRATIONS_ON_START = 'false';
  process.env.CONSUMER_ENABLED = 'false'; // default: sem consumer (habilitar via env)
  process.env.WORKERS_ENABLED = 'false'; // default: sem workers (habilitar via env)
  for (const [key, value] of Object.entries(env ?? {})) {
    process.env[key] = value;
  }
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    db,
    app,
    baseUrl,
    stop: async () => {
      await app.close();
      await db.stop();
    },
  };
}

export async function createWallet(baseUrl: string, playerId: string, balance: string): Promise<string> {
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`failed to create wallet: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export function playerIdFrom(suffix: string): string {
  return `01920000-0000-7000-8000-${suffix.padStart(12, '0')}`;
}

export async function submitTransaction(
  baseUrl: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
}
