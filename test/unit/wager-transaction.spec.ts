import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/wallets/domain/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/wagering/domain/errors';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/wagering/domain/wager-transaction';

const AT = new Date('2026-01-15T12:00:00.000Z');
const AT2 = new Date('2026-01-15T12:01:00.000Z');

const BRL = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(overrides?: Partial<Parameters<typeof WagerTransaction.create>[0]>): Parameters<typeof WagerTransaction.create>[0] {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: BRL('25.00'),
    createdAt: AT,
    ...overrides,
  };
}

describe('WagerTransaction.create', () => {
  it('nasce em PENDING com todos os campos', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.kind).toBe(WagerTransactionKind.Bet);
    expect(tx.money.toString()).toBe('25.00');
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  it('rejeita kind OPENING (interno, não submetível)', () => {
    expect(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Opening }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('REFUND e ROLLBACK exigem referência (regra 7.1)', () => {
    expect(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Refund }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback }))).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' })),
    ).not.toThrow();
  });

  it('BET e LOSS não podem carregar referência', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'ext-0' })),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, referenceExternalTransactionId: 'ext-0' })),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('WIN pode referenciar a BET da rodada (referência opcional)', () => {
    expect(() => WagerTransaction.create(props({ kind: WagerTransactionKind.Win }))).not.toThrow();
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-0' })),
    ).not.toThrow();
  });

  it('rejeita valor zero/negativo e campos vazios', () => {
    expect(() => WagerTransaction.create(props({ money: BRL('0.00') }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ id: '' }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ roundId: '  ' }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ createdAt: new Date('x') }))).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction — transições válidas', () => {
  it('PENDING → PROCESSED (BET sem referência interna)', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed(undefined, AT2);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(AT2);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → PROCESSED com referenceTransactionId resolvido', () => {
    const tx = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }));
    tx.markProcessed('tx-0-interno', AT2);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('tx-0-interno');
  });

  it('PENDING → PENDING_REFERENCE → PROCESSED (fora de ordem, regra 7.8)', () => {
    const tx = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }));
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('tx-0', AT2);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('PENDING_REFERENCE → PENDING_REFERENCE é idempotente (no-op)', () => {
    const tx = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }));
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).not.toThrow();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('PENDING → REJECTED e PENDING_REFERENCE → REJECTED com failureCode', () => {
    const a = WagerTransaction.create(props());
    a.reject(FailureCode.InsufficientFunds);
    expect(a.status).toBe(WagerTransactionStatus.Rejected);
    expect(a.failureCode).toBe(FailureCode.InsufficientFunds);

    const b = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'e' }));
    b.markPendingReference();
    b.reject(FailureCode.ReferenceTtlExpired);
    expect(b.status).toBe(WagerTransactionStatus.Rejected);
    expect(b.failureCode).toBe(FailureCode.ReferenceTtlExpired);
  });

  it('PENDING → FAILED (erro permanente de infra, auditável)', () => {
    const tx = WagerTransaction.create(props());
    tx.fail(FailureCode.InfrastructureError);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfrastructureError);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe('WagerTransaction — transições inválidas (terminais lançam)', () => {
  it('PROCESSED não transiciona mais', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed(undefined, AT2);
    expect(() => tx.markProcessed(undefined, AT2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('REJECTED não transiciona mais', () => {
    const tx = WagerTransaction.create(props());
    tx.reject(FailureCode.InsufficientFunds);
    expect(() => tx.markProcessed(undefined, AT2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.WalletNotFound)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('FAILED não transiciona mais', () => {
    const tx = WagerTransaction.create(props());
    tx.fail(FailureCode.InfrastructureError);
    expect(() => tx.markProcessed(undefined, AT2)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.WalletNotFound)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — consultas', () => {
  it('affectsBalance: LOSS não afeta, demais afetam', () => {
    for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const reference =
        kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback ? 'ext-0' : undefined;
      expect(WagerTransaction.create(props({ kind, referenceExternalTransactionId: reference })).affectsBalance()).toBe(true);
    }
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Loss })).affectsBalance()).toBe(false);
  });

  it('requiresReference: REFUND e ROLLBACK', () => {
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'e' })).requiresReference()).toBe(true);
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'e' })).requiresReference()).toBe(true);
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Bet })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: WagerTransactionKind.Win })).requiresReference()).toBe(false);
  });

  it('matchesPayload compara o hash', () => {
    const tx = WagerTransaction.create(props({ payloadHash: 'a'.repeat(64) }));
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor — todos os pares', () => {
  const bet = WagerTransaction.create(props({ kind: WagerTransactionKind.Bet }));
  const win = WagerTransaction.create(props({ kind: WagerTransactionKind.Win }));
  const refund = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-1' }));
  const loss = WagerTransaction.create(props({ kind: WagerTransactionKind.Loss }));
  const rollback = WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-1' }));

  it('BET → DEBIT', () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it('WIN e REFUND → CREDIT', () => {
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it('LOSS → sem lançamento', () => {
    expect(loss.ledgerDirectionFor()).toBeUndefined();
  });

  it('ROLLBACK inverte a referência: ref=BET → CREDIT; ref=WIN|REFUND → DEBIT', () => {
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK sem referência resolvida lança', () => {
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.rehydrate — sem revalidar', () => {
  it('reproduz estado exato, inclusive terminal', () => {
    const tx = WagerTransaction.create(props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' }));
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceTtlExpired);

    const restored = WagerTransaction.rehydrate({
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      createdAt: tx.createdAt,
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      processedAt: tx.processedAt,
    });
    expect(restored.status).toBe(WagerTransactionStatus.Rejected);
    expect(restored.failureCode).toBe(FailureCode.ReferenceTtlExpired);
    expect(restored.isTerminal()).toBe(true);
    // não revalida: estado persistido é a verdade — e terminal permanece imutável
    expect(() => restored.markProcessed('x', AT2)).toThrow(InvalidTransactionStateError);
  });

  it('restaura PROCESSADO com snapshot de referência e data', () => {
    const restored = WagerTransaction.rehydrate({
      ...props({ kind: WagerTransactionKind.Bet }),
      status: WagerTransactionStatus.Processed,
      processedAt: AT2,
    });
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.processedAt).toBe(AT2);
  });
});
