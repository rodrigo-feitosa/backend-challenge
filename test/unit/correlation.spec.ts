import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { buildLogger } from '../../src/shared/infrastructure/logging/logger';
import { correlationBindings, correlationMiddleware, runWithCorrelation, updateCorrelation } from '../../src/shared/infrastructure/logging/correlation';

/**
 * ET15: a cadeia de correlação é injetada automaticamente em toda linha de
 * log via AsyncLocalStorage + mixin do pino — e o middleware HTTP propaga
 * o header X-Correlation-ID.
 */
describe('correlation context', () => {
  function capture(): { chunks: string[]; logger: ReturnType<typeof buildLogger> } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    return { chunks, logger: buildLogger(stream) };
  }

  it('injeta correlationId, walletId, providerId e transactionId em todo log do contexto', () => {
    const { chunks, logger } = capture();
    runWithCorrelation({ correlationId: 'corr-1', walletId: 'wallet-1', providerId: 'provider-a' }, () => {
      updateCorrelation({ transactionId: 'tx-1' });
      logger.info({ scope: 'submit-wager' }, 'processing');
    });

    const line = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(line.correlationId).toBe('corr-1');
    expect(line.walletId).toBe('wallet-1');
    expect(line.providerId).toBe('provider-a');
    expect(line.transactionId).toBe('tx-1');
    expect(line.scope).toBe('submit-wager');
    expect(line.msg).toBe('processing');
  });

  it('log fora de contexto não ganha campos de correlação', () => {
    const { chunks, logger } = capture();
    logger.info('bare');
    const line = JSON.parse(chunks.join('')) as Record<string, unknown>;
    expect(line.correlationId).toBeUndefined();
    expect(line.walletId).toBeUndefined();
  });

  it('contextos aninhados não vazam bindings uns para os outros', () => {
    const { chunks, logger } = capture();
    runWithCorrelation({ correlationId: 'outer' }, () => {
      logger.info('first');
      runWithCorrelation({ correlationId: 'inner' }, () => logger.info('second'));
      logger.info('third');
    });
    const lines = chunks.join('').trim().split('\n').map((l) => JSON.parse(l) as { correlationId?: string });
    expect(lines[0].correlationId).toBe('outer');
    expect(lines[1].correlationId).toBe('inner');
    expect(lines[2].correlationId).toBe('outer');
  });

  it('updateCorrelation fora de contexto é inofensivo', () => {
    expect(() => updateCorrelation({ transactionId: 'orphan' })).not.toThrow();
    expect(correlationBindings()).toBeUndefined();
  });

  it('middleware propaga o header e expõe o contexto dentro do handler', () => {
    let seen: ReturnType<typeof correlationBindings>;
    const headers: Record<string, string> = {};
    correlationMiddleware(
      { headers: { 'x-correlation-id': 'given-1' } },
      { setHeader: (name, value) => void (headers[name] = value) },
      () => {
        seen = correlationBindings();
      },
    );
    expect(headers['x-correlation-id']).toBe('given-1');
    expect(seen!.correlationId).toBe('given-1');
  });

  it('middleware gera correlationId quando o header vem vazio', () => {
    let seen: ReturnType<typeof correlationBindings>;
    const headers: Record<string, string> = {};
    correlationMiddleware(
      { headers: {} },
      { setHeader: (name, value) => void (headers[name] = value) },
      () => {
        seen = correlationBindings();
      },
    );
    expect(headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen!.correlationId).toBe(headers['x-correlation-id']);
  });
});
