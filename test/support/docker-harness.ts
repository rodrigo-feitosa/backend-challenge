import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Harness mínimo de containers via CLI do Docker.
 *
 * Substitui o Testcontainers porque a biblioteca carrega o módulo nativo
 * ssh2, que quebra o Bun (oven-sh/bun#18546). O requisito do desafio é
 * PostgreSQL/LocalStack REAIS em containers — este harness garante exatamente
 * isso, com ciclo de vida isolado por suíte.
 *
 * NOTA: o readiness não usa `docker exec` em loop — processos filhos saindo
 * com código não-zero em rajada confundem o gerenciador de processos do
 * `bun test`. O readiness específico (SQL/fila) fica a cargo de cada suíte.
 */

export interface StartedContainer {
  containerId: string;
  hostPort: number;
  stop(): Promise<void>;
}

function run(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 }).then((r) => r.stdout.trim());
}

export function runDocker(args: string[]): Promise<string> {
  return run('docker', args);
}

/** Encontra uma porta livre no host (bind na porta 0). */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('no port')));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inicia um container e espera o Docker reportá-lo em execução.
 * O readiness da aplicação (SQL, filas) deve ser feito pela suíte.
 */
export async function startContainer(options: {
  image: string;
  name: string;
  env?: string[];
  internalPort: number;
  startTimeoutMs?: number;
}): Promise<StartedContainer> {
  const hostPort = await findFreePort();
  const args = [
    'run', '-d', '--rm',
    '--name', options.name,
    '-p', `127.0.0.1:${hostPort}:${options.internalPort}`,
    ...(options.env ?? []).flatMap((e) => ['-e', e]),
    options.image,
  ];
  const containerId = await runDocker(args);

  const timeout = options.startTimeoutMs ?? 30_000;
  const startedAt = Date.now();
  for (;;) {
    let status = '';
    try {
      status = await runDocker(['inspect', '--format', '{{.State.Status}}', options.name]);
    } catch {
      // inspect pode falhar transitoriamente; tratado abaixo
    }
    if (status === 'running') {
      return { containerId, hostPort, stop: () => stopContainer(options.name) };
    }
    if (status === 'exited' || status === 'dead') {
      throw new Error(`container ${options.name} saiu do ar (status=${status})`);
    }
    if (Date.now() - startedAt > timeout) {
      await stopContainer(options.name);
      throw new Error(`container ${options.name} não iniciou em ${timeout}ms (status=${status || 'unknown'})`);
    }
    await sleep(200);
  }
}

export async function stopContainer(name: string): Promise<void> {
  try {
    await runDocker(['stop', name]); // --rm remove o container
  } catch {
    // container já parado
  }
}
