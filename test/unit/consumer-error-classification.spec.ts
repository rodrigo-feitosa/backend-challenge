import { describe, expect, it } from 'bun:test';
import { classifyConsumerError, PermanentConsumerError } from '../../src/messaging/application/consume-wager-transaction.handler';
import { DomainError } from '../../src/shared/domain/errors';

describe('classificação de erros do consumer (§10)', () => {
  it('erro permanente explícito → permanent', () => {
    expect(classifyConsumerError(new PermanentConsumerError('bad payload'))).toBe('permanent');
  });

  it('códigos de conexão/banco transitórios → transient', () => {
    expect(classifyConsumerError({ code: 'ECONNREFUSED' })).toBe('transient');
    expect(classifyConsumerError({ code: '57P01' })).toBe('transient');
    expect(classifyConsumerError({ code: '40001' })).toBe('transient');
    expect(classifyConsumerError({ code: '40P01' })).toBe('transient');
  });

  it('INFRASTRUCTURE_ERROR → transient', () => {
    expect(classifyConsumerError(new DomainError('INFRASTRUCTURE_ERROR', 'db down'))).toBe('transient');
  });

  it('DriverException de conexão (sem código preservado) → transient', () => {
    expect(classifyConsumerError({ name: 'ConnectionError' })).toBe('transient');
    expect(classifyConsumerError({ name: 'DriverException' })).toBe('transient');
  });

  it('erro desconhecido → permanent (DLQ, não retry infinito)', () => {
    expect(classifyConsumerError(new Error('unexpected bug'))).toBe('permanent');
    expect(classifyConsumerError(new DomainError('VALIDATION_ERROR', 'bad'))).toBe('permanent');
  });
});
