import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de correlação por execução (seção 12 do desafio).
 *
 * Todo log emitido dentro do contexto recebe automaticamente os bindings
 * via mixin do pino (logger.ts) — o código de domínio não precisa propagar
 * manualmente. O uso é: HTTP entra pelo middleware (correlationId do header
 * `X-Correlation-ID` ou gerado); o canal SQS entra pelo handler com o
 * messageId como correlationId; o use case enriquece com transactionId.
 *
 * Campos logados: correlationId, messageId, transactionId, walletId,
 * providerId. NUNCA valores financeiros (seção 12 — payload financeiro
 * completo não vai a log; referência é por transactionId).
 */
export interface CorrelationBindings {
  correlationId: string;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
}

const storage = new AsyncLocalStorage<CorrelationBindings>();

/** Executa a função dentro de um contexto de correlação. */
export function runWithCorrelation<T>(bindings: CorrelationBindings, fn: () => T): T {
  return storage.run({ ...bindings }, fn);
}

/** Bindings do contexto atual (ou undefined fora de qualquer contexto). */
export function correlationBindings(): CorrelationBindings | undefined {
  return storage.getStore();
}

/** Enriquece o contexto da execução atual (ignorado fora de contexto). */
export function updateCorrelation(patch: Partial<Omit<CorrelationBindings, 'correlationId'>>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface MinimalResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * Middleware HTTP: propaga ou gera o correlationId e o devolve na resposta
 * para rastreabilidade ponta a ponta.
 */
export function correlationMiddleware(req: MinimalRequest, res: MinimalResponse, next: () => void): void {
  const header = req.headers['x-correlation-id'];
  const fromHeader = typeof header === 'string' ? header.trim() : Array.isArray(header) ? header[0]?.trim() : undefined;
  const correlationId = fromHeader && fromHeader !== '' ? fromHeader : randomUUID();
  res.setHeader('x-correlation-id', correlationId);
  runWithCorrelation({ correlationId }, () => next());
}
