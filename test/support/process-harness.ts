import { spawn, type ChildProcess } from 'node:child_process';
import { findFreePort } from './docker-harness';

/**
 * Harness de processos reais da aplicação (C4/C5/C8): spawn de `bun src/main.ts`
 * com banco/SQS compartilhados e portas distintas — multi-instância de verdade.
 */

const PROJECT_ROOT = new URL('../../', import.meta.url).pathname;

export interface AppProcessHandle {
  port: number;
  baseUrl: string;
  kill(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

export async function waitFor(predicate: () => Promise<boolean>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 200;
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function startAppProcess(env: Record<string, string> = {}, fixedPort?: number): Promise<AppProcessHandle> {
  const port = fixedPort ?? (await findFreePort());
  const child: ChildProcess = spawn('bun', ['src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env, PORT: String(port), MIGRATIONS_ON_START: 'false' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;

  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error('app process exited during startup');
      try {
        const res = await fetch(`${baseUrl}/health/live`);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 30000 },
  );

  return {
    port,
    baseUrl,
    kill: async (signal = 'SIGTERM') => {
      if (child.exitCode !== null) return;
      child.kill(signal);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([exited, timeout]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

/** Submissão com retry entre instâncias — mesma key = seguro (replay). */
export async function submitWithRetry(
  baseUrls: string[],
  body: Record<string, unknown>,
  idempotencyKey: string,
  maxAttempts = 4,
): Promise<{ ok: boolean; status?: number; failureCode?: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const baseUrl = baseUrls[attempt % baseUrls.length];
    try {
      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = new Error(`transient status ${res.status}`);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const payload = (await res.json()) as { status?: string; failureCode?: string };
      return { ok: true, status: res.status, failureCode: payload.failureCode };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`all submission attempts failed: ${String(lastError)}`);
}
